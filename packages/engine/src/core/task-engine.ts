import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type {
  AgentResponse,
  ClarifierAgentOutput,
  ClarificationQuestion,
  DocsImpact,
  EvidenceRequirement,
  GateKind,
  PlannerAgentOutput,
  PlanningAgentRole,
  QueueItem,
  RepositoryContextEntry,
  SliceDefinition,
  SliceForgeConfig,
  SliceGraph,
  TaskAttachment,
  TaskEvent,
  TaskPacket,
  TaskRecord,
  TaskRequest,
  TaskStatus,
} from "./contracts.js";
import {
  AgentProtocolRunner,
  createPlanningAgentRequest,
  parseStrictJson,
} from "./agent-protocol.js";
import { loadConfig, validatePlan } from "./config-loader.js";
import { GitService } from "./git-service.js";
import {
  appendJournalRecord,
  atomicWrite,
  getRuntimePaths,
  readJournalRecords,
  RuntimeStore,
} from "./runtime-store.js";
import { runProcess } from "./process-runner.js";
import { stringify as stringifyYaml } from "yaml";
import { minimatch } from "minimatch";
import { routeAgent, taskComplexity } from "./agent-router.js";
import { notifyProgress, type ProgressCallback } from "./progress.js";

const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  draft: new Set(["clarifying", "ready_to_plan", "cancelled", "failed"]),
  clarifying: new Set(["clarifying", "ready_to_plan", "cancelled", "failed"]),
  ready_to_plan: new Set(["planning", "cancelled", "failed"]),
  planning: new Set(["awaiting_approval", "clarifying", "failed", "cancelled"]),
  awaiting_approval: new Set(["ready_to_plan", "queued", "clarifying", "failed", "cancelled"]),
  queued: new Set(["running", "cancelled", "blocked"]),
  running: new Set(["ready_to_promote", "needs_attention", "failed", "blocked", "cancelled"]),
  needs_attention: new Set([
    "queued",
    "ready_to_plan",
    "clarifying",
    "ready_to_promote",
    "cancelled",
    "failed",
  ]),
  ready_to_promote: new Set(["ready_to_plan", "clarifying", "promoting", "blocked", "cancelled"]),
  promoting: new Set(["promoted", "failed", "blocked"]),
  promoted: new Set(["promoted"]),
  failed: new Set(["ready_to_plan", "clarifying", "queued", "cancelled"]),
  blocked: new Set(["ready_to_plan", "clarifying", "queued", "cancelled"]),
  cancelled: new Set(),
};

export interface TaskIntakeOptions {
  from?: string;
  images?: string[];
  figma?: string;
  targets?: string[];
  constraints?: string[];
  priority?: number;
  onProgress?: ProgressCallback;
}

function hash(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sliceGraphFingerprint(graph: Omit<SliceGraph, "fingerprint"> | SliceGraph): string {
  const content = Object.fromEntries(
    Object.entries(graph).filter(([key]) => key !== "fingerprint"),
  );
  return hash(content);
}

function safeId(value: string): string {
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) throw new Error(`Invalid task id: ${value}`);
  return value;
}

function taskId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `${stamp}-task-${crypto.randomBytes(4).toString("hex")}`;
}

export class TaskStore {
  constructor(readonly runtime: RuntimeStore) {}

  directory(id: string): string {
    return path.join(this.runtime.paths.tasks, safeId(id));
  }

  save(task: TaskRecord): void {
    task.updatedAt = new Date().toISOString();
    atomicWrite(
      path.join(this.directory(task.taskId), "state.json"),
      JSON.stringify(task, null, 2),
    );
  }

  load(id: string): TaskRecord {
    const statePath = path.join(this.directory(id), "state.json");
    if (!fs.existsSync(statePath)) throw new Error(`Task not found: ${id}`);
    let task = JSON.parse(fs.readFileSync(statePath, "utf8")) as TaskRecord;
    const latest = this.events(id).at(-1);
    if (latest && latest.sequence > task.sequence) {
      const snapshot = latest.data?.snapshot as TaskRecord | undefined;
      if (
        snapshot?.taskId === task.taskId &&
        snapshot.sequence === latest.sequence &&
        snapshot.status === latest.status
      ) {
        task = snapshot;
      } else {
        task.sequence = latest.sequence;
        task.status = latest.status;
      }
      this.save(task);
    }
    return task;
  }

  list(): TaskRecord[] {
    if (!fs.existsSync(this.runtime.paths.tasks)) return [];
    return fs
      .readdirSync(this.runtime.paths.tasks, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        try {
          return [this.load(entry.name)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  transition(
    task: TaskRecord,
    status: TaskStatus,
    message: string,
    data?: Record<string, unknown>,
  ): TaskEvent {
    if (task.status !== status && !TASK_TRANSITIONS[task.status].has(status)) {
      throw new Error(`Invalid task transition: ${task.status} -> ${status}`);
    }
    task.status = status;
    task.sequence += 1;
    const event: TaskEvent = {
      sequence: task.sequence,
      timestamp: new Date().toISOString(),
      status,
      message,
      data: {
        ...data,
        snapshot: JSON.parse(JSON.stringify(task)) as TaskRecord,
      },
    };
    appendJournalRecord(path.join(this.directory(task.taskId), "events.jsonl"), event);
    this.save(task);
    return event;
  }

  events(id: string): TaskEvent[] {
    const eventPath = path.join(this.directory(id), "events.jsonl");
    return readJournalRecords<TaskEvent>(eventPath);
  }
}

function repositoryContext(
  projectRoot: string,
  config: SliceForgeConfig,
  targets: string[],
  request: string,
): RepositoryContextEntry[] {
  const ignoredDirectories = new Set([
    ".git",
    ".sliceforge",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "bin",
    "obj",
    ".next",
    ".turbo",
  ]);
  const conventionNames = new Set([
    "agents.md",
    "claude.md",
    "contributing.md",
    "readme.md",
    ".editorconfig",
    ".cursorrules",
    "copilot-instructions.md",
  ]);
  const manifestNames = new Set([
    "package.json",
    "pnpm-workspace.yaml",
    "nx.json",
    "turbo.json",
    "pyproject.toml",
    "requirements.txt",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
  ]);
  const keywords = request
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((word) => word.length >= 4)
    .slice(0, 30);
  const candidates = new Map<
    string,
    { kind: RepositoryContextEntry["kind"]; score: number; content: Buffer }
  >();
  const roots = [
    projectRoot,
    ...targets.map((target) => path.resolve(projectRoot, config.targets[target].root)),
  ];
  let visited = 0;
  const visit = (directory: string, depth: number): void => {
    if (depth > 5 || visited >= 3000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited++ >= 3000) return;
      if (ignoredDirectories.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(absolute, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(projectRoot, absolute).replace(/\\/g, "/");
      if (
        relative === ".." ||
        relative.startsWith("../") ||
        config.policies.protectedPatterns.some((pattern) =>
          minimatch(relative, pattern, { dot: true }),
        )
      ) {
        continue;
      }
      let size: number;
      try {
        size = fs.statSync(absolute).size;
      } catch {
        continue;
      }
      if (size > 128 * 1024) continue;
      const lowerName = entry.name.toLowerCase();
      const lowerPath = relative.toLowerCase();
      let kind: RepositoryContextEntry["kind"] | undefined;
      if (conventionNames.has(lowerName)) kind = "convention";
      else if (manifestNames.has(lowerName) || /\.(sln|csproj|fsproj|vbproj)$/.test(lowerName))
        kind = "manifest";
      else if (
        /(api|schema|openapi|swagger|graphql|proto|controller|route)/.test(lowerPath) &&
        /\.(json|ya?ml|graphql|gql|proto|ts|tsx|js|jsx|cs|py|java|kt)$/.test(lowerName)
      )
        kind = "api-schema";
      else if (/\.(md|mdx|txt)$/.test(lowerName)) kind = "documentation";
      if (!kind) continue;
      let content: Buffer;
      try {
        content = fs.readFileSync(absolute);
      } catch {
        continue;
      }
      if (content.includes(0)) continue;
      const text = content.toString("utf8").toLowerCase();
      const relevance = keywords.filter(
        (keyword) => lowerPath.includes(keyword) || text.includes(keyword),
      ).length;
      const priority =
        kind === "convention" ? 40 : kind === "manifest" ? 30 : kind === "api-schema" ? 20 : 10;
      candidates.set(relative, { kind, score: priority + relevance, content });
    }
  };
  for (const root of [...new Set(roots.map((item) => path.resolve(item)))]) visit(root, 0);

  let snippetBytes = 0;
  const result: RepositoryContextEntry[] = [];
  for (const [relative, candidate] of [...candidates.entries()].sort(
    ([leftPath, left], [rightPath, right]) =>
      right.score - left.score || leftPath.localeCompare(rightPath),
  )) {
    if (result.length >= 40 || snippetBytes >= 64 * 1024) break;
    const available = Math.min(2048, 64 * 1024 - snippetBytes);
    const snippet = candidate.content.toString("utf8", 0, available);
    snippetBytes += Buffer.byteLength(snippet, "utf8");
    result.push({
      path: relative,
      kind: candidate.kind,
      sha256: crypto.createHash("sha256").update(candidate.content).digest("hex"),
      sizeBytes: candidate.content.length,
      snippet,
    });
  }
  return result;
}

function scoreRequest(request: string, hasDesign: boolean): number {
  const text = request.toLowerCase();
  const ui = /màn hình|screen|ui|ux|dashboard|page|form/.test(text);
  let score = request.trim().split(/\s+/).length >= 8 ? 20 : 8;
  if (/mục tiêu|goal|để |so that|user|người dùng|cho phép/.test(text)) score += 16;
  if (/khi |when |click|nhấn|chọn|submit|tạo|sửa|xóa|hiển thị/.test(text)) score += 16;
  if (/api|data|dữ liệu|field|trường|endpoint|response|request/.test(text)) score += 16;
  if (!ui || hasDesign || /loading|empty|error|success|responsive|mobile|desktop/.test(text))
    score += 16;
  if (/test|kiểm tra|expected|acceptance|phải|must|should/.test(text)) score += 16;
  return Math.min(100, score);
}

function clarificationQuestions(request: string, hasDesign: boolean): ClarificationQuestion[] {
  const text = request.toLowerCase();
  const questions: ClarificationQuestion[] = [];
  if (
    request.trim().split(/\s+/).length < 8 ||
    /^(làm|tạo|sửa|cải thiện)\s+.{0,35}$/i.test(request)
  ) {
    questions.push({
      id: "expected-outcome",
      question: "Kết quả quan sát được nào chứng minh task đã hoàn thành?",
      recommendation:
        "Mô tả hành vi người dùng và kết quả cụ thể thay vì chỉ tên màn hình/tính năng.",
    });
  }
  if (/màn hình|screen|ui|ux|dashboard|page|form/.test(text) && !hasDesign) {
    questions.push({
      id: "interaction-contract",
      question: "Màn hình cần các trạng thái và thao tác chính nào?",
      recommendation: "Xác nhận loading, empty, error, success, responsive và hành động chính.",
    });
  }
  if (
    /api|data|dữ liệu|form|dashboard|list|danh sách/.test(text) &&
    !/endpoint|field|trường|response/.test(text)
  ) {
    questions.push({
      id: "data-contract",
      question: "Nguồn dữ liệu hoặc API contract nào được sử dụng?",
      recommendation: "Nêu endpoint/schema hiện có hoặc xác nhận dùng mock contract cho discovery.",
    });
  }
  return questions.slice(0, 3);
}

function docsImpact(request: string, configured: DocsImpact): DocsImpact {
  return /cli|command|api|schema|config|public|hướng dẫn|documentation|docs/i.test(request)
    ? "required"
    : configured;
}

function executableGates(
  config: SliceForgeConfig,
  targets: string[],
): NonNullable<SliceDefinition["requiredGates"]> {
  const kinds = ["build", "lint", "unit", "integration", "e2e"] as const;
  return kinds.filter((kind) =>
    targets.some((target) => Boolean(config.targets[target].commands[kind])),
  );
}

function buildDeterministicGraph(
  task: TaskRecord,
  config: SliceForgeConfig,
  projectRoot: string,
): SliceGraph {
  const targets = task.request.targets;
  const gates = executableGates(config, targets);
  const id = `task-${task.taskId.slice(-13).toLowerCase()}`;
  const acceptanceId = `${id.toUpperCase()}-AC-001`;
  const targetRoot = config.targets[targets[0]].root.replace(/\\/g, "/").replace(/\/$/, "");
  const impact = docsImpact(task.request.request, config.documentation?.defaultImpact ?? "review");
  const fallbackArtifact = gates.length ? undefined : `docs/specs/${id}.md`;
  const docsArtifact = impact === "required" ? `docs/tasks/${id}.md` : undefined;
  const requiredArtifacts = [fallbackArtifact, docsArtifact].filter((item): item is string =>
    Boolean(item),
  );
  const acceptance = [{ id: acceptanceId, expected: task.request.request }];
  if (docsArtifact) {
    acceptance.push({
      id: `${id.toUpperCase()}-DOC-001`,
      expected: `${docsArtifact} documents the public behavior introduced by this task.`,
    });
  }
  const slice: SliceDefinition = {
    id,
    title: task.request.request.split(/\r?\n/, 1)[0].slice(0, 120),
    description: [
      task.request.request,
      ...task.packet.decisions.map((item) => item.answer),
      task.request.attachments.length
        ? `Local input references:\n${JSON.stringify(task.request.attachments, null, 2)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    priority: task.request.priority,
    targets,
    acceptance,
    allowedPaths: [
      ...(gates.length ? [targetRoot === "." ? "**/*" : `${targetRoot}/**/*`] : []),
      ...(fallbackArtifact ? ["docs/specs/**"] : []),
      ...(docsArtifact ? ["docs/tasks/**"] : []),
    ],
    requiredArtifacts: requiredArtifacts.length ? requiredArtifacts : undefined,
    requiredGates: [...gates, ...(requiredArtifacts.length ? (["artifact"] as const) : [])],
    docs: docsArtifact ? [docsArtifact] : undefined,
    docsImpact: impact,
    retryPolicy: { maxAttempts: (config.execution?.maxRepairAttempts ?? 3) + 1 },
  };
  const evidence: EvidenceRequirement[] = [
    {
      acceptanceId,
      kind: fallbackArtifact ? "artifact" : "command",
      source: fallbackArtifact ?? gates[0],
      required: true,
    },
  ];
  if (docsArtifact) {
    evidence.push({
      acceptanceId: `${id.toUpperCase()}-DOC-001`,
      kind: "artifact",
      source: docsArtifact,
      required: true,
    });
  }
  slice.evidence = evidence;
  validatePlan({ schemaVersion: 1, slices: [slice] }, config, projectRoot);
  const graphWithoutFingerprint = {
    taskId: task.taskId,
    revision: task.revision,
    slices: [slice],
    evidence: evidence.map((item) => ({ ...item })),
    assumptions: task.packet.assumptions,
    risks:
      task.packet.readinessScore < 80
        ? ["Task readiness is below 80; review the plan carefully."]
        : [],
  };
  return {
    ...graphWithoutFingerprint,
    fingerprint: sliceGraphFingerprint(graphWithoutFingerprint),
  };
}

function targetGateContext(
  config: SliceForgeConfig,
  targets: string[],
): Record<string, GateKind[]> {
  return Object.fromEntries(
    targets.map((target) => {
      const gates = Object.keys(config.targets[target].commands) as GateKind[];
      if (config.gates.browser.enabled && config.gates.browser.command) gates.push("browser");
      return [target, [...new Set(gates)]];
    }),
  );
}

function evidenceSourceIsExecutable(
  slice: SliceDefinition,
  requirement: EvidenceRequirement,
): boolean {
  const gates = new Set(slice.requiredGates ?? []);
  if (requirement.kind === "manual") return true;
  if (requirement.kind === "artifact") {
    return (
      gates.has("artifact") &&
      Boolean(requirement.source && slice.requiredArtifacts?.includes(requirement.source))
    );
  }
  if (requirement.kind === "visual") {
    return gates.has("browser") && (!requirement.source || requirement.source === "browser");
  }
  const allowed =
    requirement.kind === "test"
      ? new Set<GateKind>(["unit", "integration", "e2e", "browser"])
      : new Set<GateKind>(["build", "lint", "unit", "integration", "e2e", "browser"]);
  return requirement.source
    ? allowed.has(requirement.source as GateKind) && gates.has(requirement.source as GateKind)
    : [...allowed].some((gate) => gates.has(gate));
}

function assertPlannerOwnership(
  task: TaskRecord,
  config: SliceForgeConfig,
  slice: SliceDefinition,
): void {
  const roots = task.request.targets.map((target) =>
    config.targets[target].root.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, ""),
  );
  for (const target of slice.targets) {
    if (!task.request.targets.includes(target)) {
      throw new Error(`Planner slice '${slice.id}' uses target '${target}' outside task scope.`);
    }
  }
  if (roots.includes(".") || roots.includes("")) return;
  for (const configuredPath of slice.allowedPaths) {
    const normalized = configuredPath.replace(/\\/g, "/").replace(/^\.\//, "");
    const staticPrefix = normalized.split(/[*?[{]/, 1)[0].replace(/\/$/, "");
    const owned = roots.some(
      (root) => staticPrefix === root || staticPrefix.startsWith(`${root}/`),
    );
    const documentation =
      slice.docsImpact !== "none" && (staticPrefix === "docs" || staticPrefix.startsWith("docs/"));
    if (!owned && !documentation) {
      throw new Error(
        `Planner slice '${slice.id}' allowed path '${configuredPath}' is outside selected target ownership.`,
      );
    }
  }
}

function buildPlannerGraph(
  task: TaskRecord,
  config: SliceForgeConfig,
  projectRoot: string,
  output: PlannerAgentOutput,
): SliceGraph {
  const plan = validatePlan({ schemaVersion: 1, slices: output.slices }, config, projectRoot);
  if (task.request.attachments.length) {
    const references = `Engine-owned local input references:\n${JSON.stringify(task.request.attachments, null, 2)}`;
    for (const slice of plan.slices) {
      slice.description = [slice.description, references].filter(Boolean).join("\n\n");
    }
  }
  const evidence: EvidenceRequirement[] = [];
  for (const slice of plan.slices) {
    assertPlannerOwnership(task, config, slice);
    for (const criterion of slice.acceptance) {
      const requirements = (slice.evidence ?? []).filter(
        (item) => item.acceptanceId === criterion.id && item.required !== false,
      );
      if (!requirements.length) {
        throw new Error(
          `Planner slice '${slice.id}' acceptance '${criterion.id}' has no required evidence.`,
        );
      }
      for (const requirement of requirements) {
        if (!evidenceSourceIsExecutable(slice, requirement)) {
          throw new Error(
            `Planner slice '${slice.id}' evidence '${requirement.acceptanceId}:${requirement.kind}:${requirement.source ?? ""}' is not tied to a declared executable gate or artifact.`,
          );
        }
      }
    }
    evidence.push(...(slice.evidence ?? []).map((item) => ({ ...item })));
  }
  const graphWithoutFingerprint = {
    taskId: task.taskId,
    revision: task.revision,
    slices: plan.slices,
    evidence,
    assumptions: [...new Set([...task.packet.assumptions, ...output.assumptions])],
    risks: [...new Set(output.risks)],
    estimatedCostUSD: output.estimatedCostUSD,
  };
  return {
    ...graphWithoutFingerprint,
    fingerprint: sliceGraphFingerprint(graphWithoutFingerprint),
  };
}

export class TaskEngine {
  readonly tasks: TaskStore;
  private readonly agents = new AgentProtocolRunner();

  private constructor(
    readonly projectRoot: string,
    readonly config: SliceForgeConfig,
    readonly runtime: RuntimeStore,
  ) {
    this.tasks = new TaskStore(runtime);
  }

  static async open(projectRoot: string): Promise<TaskEngine> {
    const root = path.resolve(projectRoot);
    const config = loadConfig(root);
    const git = new GitService(root);
    await git.assertRepository();
    return new TaskEngine(
      root,
      config,
      new RuntimeStore(getRuntimePaths(root, await git.commonDir())),
    );
  }

  private copyAttachment(
    task: TaskRecord,
    source: string,
    kind: "document" | "image",
  ): TaskAttachment {
    const absolute = path.resolve(this.projectRoot, source);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new Error(`Task attachment is not a file: ${source}`);
    }
    if (fs.lstatSync(absolute).isSymbolicLink())
      throw new Error(`Symlink attachments are not allowed: ${source}`);
    const content = fs.readFileSync(absolute);
    const limit = this.config.inputs?.maxAttachmentBytes ?? 10 * 1024 * 1024;
    if (content.length > limit) throw new Error(`Attachment exceeds ${limit} bytes: ${source}`);
    if (kind === "image") {
      const png = content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
      const gif = content.subarray(0, 4).toString("ascii") === "GIF8";
      const webp =
        content.subarray(0, 4).toString("ascii") === "RIFF" &&
        content.subarray(8, 12).toString("ascii") === "WEBP";
      if (!png && !jpeg && !gif && !webp) {
        throw new Error(
          `Unsupported or invalid image attachment: ${source}. Use PNG, JPEG, GIF or WebP.`,
        );
      }
    } else if (content.includes(0)) {
      throw new Error(`Document attachment appears to be binary: ${source}`);
    }
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const id = `${kind}-${digest.slice(0, 12)}`;
    const storedPath = path.join(
      this.tasks.directory(task.taskId),
      "attachments",
      `${id}${path.extname(absolute)}`,
    );
    fs.mkdirSync(path.dirname(storedPath), { recursive: true });
    fs.writeFileSync(storedPath, content, { mode: 0o600 });
    return { id, kind, source, storedPath, sha256: digest, sizeBytes: content.length };
  }

  private async figmaAttachment(task: TaskRecord, source: string): Promise<TaskAttachment> {
    const id = `figma-${hash(source).slice(0, 12)}`;
    const provider = this.config.inputs?.figmaProvider;
    if (!provider) return { id, kind: "figma", source };
    const result = await runProcess(provider, {
      root: this.projectRoot,
      stdin: JSON.stringify({ protocolVersion: "1.0", taskId: task.taskId, figmaUrl: source }),
      maxOutputBytes: this.config.reporting.maxLogBytes,
      secrets: [process.env.FIGMA_TOKEN ?? ""],
    });
    if (result.exitCode !== 0) {
      throw new Error(`Configured Figma provider failed: ${result.stderr}`);
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJson(result.stdout);
    } catch {
      throw new Error("Configured Figma provider must return exactly one JSON document.");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Configured Figma provider must return one JSON object.");
    }
    const content = Buffer.from(JSON.stringify(parsed, null, 2), "utf8");
    const limit = this.config.inputs?.maxAttachmentBytes ?? 10 * 1024 * 1024;
    if (content.length > limit) throw new Error(`Figma context exceeds ${limit} bytes.`);
    const digest = crypto.createHash("sha256").update(content).digest("hex");
    const storedPath = path.join(this.tasks.directory(task.taskId), "attachments", `${id}.json`);
    fs.mkdirSync(path.dirname(storedPath), { recursive: true });
    fs.writeFileSync(storedPath, content, { mode: 0o600 });
    return { id, kind: "figma", source, storedPath, sha256: digest, sizeBytes: content.length };
  }

  private deterministicPacket(request: TaskRequest, prior?: TaskPacket): TaskPacket {
    const design = request.attachments.some(
      (item) => item.kind === "image" || item.kind === "figma",
    );
    const answered = new Map(
      (prior?.decisions ?? []).map((item) => [item.questionId, item.answer]),
    );
    const readinessScore = Math.min(
      100,
      scoreRequest(request.request, design) + answered.size * 10,
    );
    const generatedQuestions = clarificationQuestions(request.request, design);
    if (
      readinessScore < (this.config.routing?.minimumReadinessScore ?? 70) &&
      generatedQuestions.length < 3
    ) {
      generatedQuestions.push({
        id: "readiness-gap",
        question: "Phạm vi, kết quả mong đợi và cách kiểm chứng cụ thể của task là gì?",
        recommendation:
          "Nêu rõ phần được phép thay đổi, hành vi quan sát được và test/gate chứng minh hoàn thành.",
      });
    }
    const questions = generatedQuestions.map((question) => ({
      ...question,
      answer: answered.get(question.id),
    }));
    const unresolved = questions.filter((question) => !question.answer);
    const files = repositoryContext(
      this.projectRoot,
      this.config,
      request.targets,
      request.request,
    );
    const contextSummary = {
      project: this.config.project,
      targets: request.targets,
      targetRoots: Object.fromEntries(
        request.targets.map((target) => [target, this.config.targets[target].root]),
      ),
      documentation: files
        .filter((entry) => entry.kind === "documentation" || entry.kind === "convention")
        .map((entry) => entry.path),
      files,
    };
    return {
      request,
      contextFingerprint: hash({
        contextSummary,
        attachments: request.attachments.map((item) => item.sha256 ?? item.source),
      }),
      contextSummary,
      readinessScore,
      assumptions: ["Original worktree remains unchanged until explicit promote."],
      decisions: [...answered].map(([questionId, answer]) => ({ questionId, answer })),
      blockers: unresolved.map((question) => question.id),
      questions,
    };
  }

  private async runPlanningAgent(
    task: TaskRecord,
    role: PlanningAgentRole,
    proposal: ClarifierAgentOutput | PlannerAgentOutput,
    onProgress?: ProgressCallback,
  ): Promise<AgentResponse | undefined> {
    const definition = routeAgent(this.config, role, {
      targets: task.request.targets,
      complexity: taskComplexity(task.request),
    });
    if (!definition) return undefined;
    const git = new GitService(this.projectRoot);
    const baseSha = await git.head();
    const worktreePath = path.join(
      this.runtime.paths.worktrees,
      `planning-${task.taskId}-r${task.revision}-${role}-${crypto.randomBytes(3).toString("hex")}`,
    );
    await git.createDetachedWorktree(worktreePath, baseSha);
    try {
      const before = await git.fingerprint(baseSha, worktreePath);
      notifyProgress(
        onProgress,
        `${role === "clarifier" ? "Clarifier" : "Planner"} agent is working (read-only)...`,
      );
      const response = await this.agents.run(
        definition,
        createPlanningAgentRequest(task.taskId, role, worktreePath, {
          task: task.request,
          packet: role === "planner" ? task.packet : undefined,
          constraints: {
            readOnly: true,
            maxQuestions: 3,
            allowedTargets: task.request.targets,
            targetRoots: Object.fromEntries(
              task.request.targets.map((target) => [target, this.config.targets[target].root]),
            ),
          },
          context: {
            project: this.config.project,
            documentation: task.packet.contextSummary.documentation,
            repositoryContext: task.packet.contextSummary.files,
            targetGates: targetGateContext(this.config, task.request.targets),
            proposal,
          },
        }),
        this.config.reporting.maxLogBytes,
      );
      const after = await git.fingerprint(baseSha, worktreePath);
      if (after !== before) {
        throw new Error(`${role} agent mutated its read-only planning worktree.`);
      }
      task.planningAgentResponses = { ...task.planningAgentResponses, [role]: response };
      this.tasks.save(task);
      notifyProgress(
        onProgress,
        `${role === "clarifier" ? "Clarifier" : "Planner"} agent completed.`,
      );
      return response;
    } finally {
      try {
        await git.removeWorktree(worktreePath, true);
      } catch {
        // Runtime clean can prune an interrupted read-only planning worktree.
      }
    }
  }

  private async packet(
    task: TaskRecord,
    prior?: TaskPacket,
    onProgress?: ProgressCallback,
  ): Promise<TaskPacket> {
    const base = this.deterministicPacket(task.request, prior);
    const proposal: ClarifierAgentOutput = {
      kind: "clarification",
      readinessScore: base.readinessScore,
      questions: base.questions
        .filter((question) => base.blockers.includes(question.id))
        .map(({ id, question, recommendation }) => ({
          id,
          question,
          recommendation,
        })),
      assumptions: base.assumptions,
      blockers: base.blockers,
    };
    const response = await this.runPlanningAgent(task, "clarifier", proposal, onProgress);
    if (!response) return base;
    if (response.status === "failed") throw new Error(`Clarifier failed: ${response.summary}`);
    if (response.output?.kind !== "clarification") {
      throw new Error("Clarifier response did not contain clarification output.");
    }
    if (response.status === "blocked" && response.output.blockers.length === 0) {
      throw new Error("Blocked clarifier response must identify at least one blocking question.");
    }
    const answered = new Map(base.decisions.map((item) => [item.questionId, item.answer]));
    const merged = new Map<string, ClarificationQuestion>();
    for (const question of [...base.questions, ...response.output.questions]) {
      if (merged.size >= 3 && !merged.has(question.id)) continue;
      merged.set(question.id, { ...question, answer: answered.get(question.id) });
    }
    const blockingIds = new Set([...base.blockers, ...response.output.blockers]);
    const questions = [...merged.values()];
    const blockers = questions
      .filter((question) => blockingIds.has(question.id) && !question.answer)
      .map((question) => question.id);
    return {
      ...base,
      readinessScore: Math.round(base.readinessScore * 0.6 + response.output.readinessScore * 0.4),
      assumptions: [...new Set([...base.assumptions, ...response.output.assumptions])],
      blockers,
      questions,
    };
  }

  private async graph(task: TaskRecord, onProgress?: ProgressCallback): Promise<SliceGraph> {
    const proposal = buildDeterministicGraph(task, this.config, this.projectRoot);
    const response = await this.runPlanningAgent(
      task,
      "planner",
      {
        kind: "plan",
        slices: proposal.slices,
        assumptions: proposal.assumptions,
        risks: proposal.risks,
        estimatedCostUSD: proposal.estimatedCostUSD,
      },
      onProgress,
    );
    if (!response) return proposal;
    if (response.status !== "completed")
      throw new Error(`Planner ${response.status}: ${response.summary}`);
    if (response.output?.kind !== "plan") {
      throw new Error("Planner response did not contain plan output.");
    }
    const output = {
      ...response.output,
      estimatedCostUSD: response.output.estimatedCostUSD ?? response.usage?.estimatedCostUSD,
    };
    return buildPlannerGraph(task, this.config, this.projectRoot, output);
  }

  async create(rawRequest: string, options: TaskIntakeOptions = {}): Promise<TaskRecord> {
    let requestText = rawRequest.trim();
    const now = new Date().toISOString();
    const id = taskId();
    const priority = options.priority ?? 50;
    if (!Number.isInteger(priority) || priority < 0 || priority > 1_000_000) {
      throw new Error("Task priority must be an integer between 0 and 1000000.");
    }
    const selectedTargets = [
      ...new Set(options.targets?.length ? options.targets : [Object.keys(this.config.targets)[0]]),
    ];
    for (const target of selectedTargets) {
      if (!this.config.targets[target]) throw new Error(`Unknown task target: ${target}`);
    }
    const request: TaskRequest = {
      id,
      request: requestText,
      targets: selectedTargets,
      constraints: options.constraints ?? [],
      priority,
      attachments: [],
      createdAt: now,
    };
    const placeholderPacket = {} as TaskPacket;
    const task: TaskRecord = {
      schemaVersion: 1,
      taskId: id,
      projectRoot: this.projectRoot,
      status: "draft",
      request,
      packet: placeholderPacket,
      runIds: [],
      supersededRunIds: [],
      evidence: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
      sequence: 0,
    };
    if (options.from) {
      const attachment = this.copyAttachment(task, options.from, "document");
      request.attachments.push(attachment);
      const content = fs.readFileSync(attachment.storedPath!, "utf8").trim();
      requestText = [requestText, content].filter(Boolean).join("\n\n");
      request.request = requestText;
    }
    for (const image of options.images ?? [])
      request.attachments.push(this.copyAttachment(task, image, "image"));
    if (options.figma) {
      let parsed: URL;
      try {
        parsed = new URL(options.figma);
      } catch {
        throw new Error("Figma input must be a valid HTTPS URL.");
      }
      if (parsed.protocol !== "https:") throw new Error("Figma input must use HTTPS.");
      if (!(parsed.hostname === "figma.com" || parsed.hostname.endsWith(".figma.com"))) {
        throw new Error("Figma input must use a figma.com hostname.");
      }
      request.attachments.push(await this.figmaAttachment(task, options.figma));
    }
    if (!request.request) throw new Error("Task request cannot be empty.");
    notifyProgress(options.onProgress, "Preparing request context...");
    task.packet = this.deterministicPacket(request);
    this.tasks.save(task);
    try {
      task.packet = await this.packet(task, undefined, options.onProgress);
      this.tasks.save(task);
    } catch (error) {
      task.lastError = error instanceof Error ? error.message : String(error);
      this.tasks.transition(task, "failed", "Structured clarification failed.", {
        error: task.lastError,
      });
      throw new Error(`Task ${task.taskId} clarification failed: ${task.lastError}`);
    }
    if (task.packet.blockers.length) {
      this.tasks.transition(task, "clarifying", "Task needs answers before planning.", {
        blockers: task.packet.blockers,
      });
      notifyProgress(options.onProgress, "Clarification questions are ready.");
      return task;
    }
    return this.plan(task, options.onProgress);
  }

  async answer(id: string, answers: Record<string, string>): Promise<TaskRecord> {
    const task = this.tasks.load(id);
    if (task.status !== "clarifying" && task.status !== "awaiting_approval") {
      throw new Error(`Task ${id} cannot accept answers in status ${task.status}.`);
    }
    const known = new Set(task.packet.questions.map((question) => question.id));
    for (const [questionId, answer] of Object.entries(answers)) {
      if (!known.has(questionId)) throw new Error(`Unknown clarification question: ${questionId}`);
      if (!answer.trim()) throw new Error(`Answer cannot be empty: ${questionId}`);
    }
    task.packet.decisions = [
      ...task.packet.decisions.filter((item) => answers[item.questionId] === undefined),
      ...Object.entries(answers).map(([questionId, answer]) => ({
        questionId,
        answer: answer.trim(),
      })),
    ];
    const prior = task.packet;
    this.tasks.save(task);
    try {
      task.packet = await this.packet(task, prior);
    } catch (error) {
      task.lastError = error instanceof Error ? error.message : String(error);
      this.tasks.transition(task, "failed", "Structured clarification failed after answers.", {
        error: task.lastError,
      });
      throw new Error(`Task ${task.taskId} clarification failed: ${task.lastError}`);
    }
    task.revision += 1;
    task.graph = undefined;
    task.approvedFingerprint = undefined;
    if (task.packet.blockers.length) {
      this.tasks.transition(task, "clarifying", "Clarification recorded; blockers remain.", {
        blockers: task.packet.blockers,
      });
      return task;
    }
    this.tasks.transition(
      task,
      "ready_to_plan",
      "All blocking clarification questions are answered.",
    );
    return this.plan(task);
  }

  async plan(task: TaskRecord, onProgress?: ProgressCallback): Promise<TaskRecord> {
    if (!task.packet || task.packet.blockers.length)
      throw new Error("Task still has unresolved blockers.");
    if (task.status === "draft")
      this.tasks.transition(task, "ready_to_plan", "Task is ready for planning.");
    this.tasks.transition(task, "planning", "Building a validated Slice Graph.");
    notifyProgress(onProgress, "Building and validating the Slice Graph...");
    try {
      task.graph = await this.graph(task, onProgress);
    } catch (error) {
      task.lastError = error instanceof Error ? error.message : String(error);
      this.tasks.transition(task, "failed", "Structured planning failed validation.", {
        error: task.lastError,
      });
      throw new Error(`Task ${task.taskId} planning failed: ${task.lastError}`);
    }
    atomicWrite(
      path.join(this.tasks.directory(task.taskId), `plan-revision-${task.revision}.yaml`),
      stringifyYaml({
        schemaVersion: 1,
        taskId: task.taskId,
        revision: task.revision,
        fingerprint: task.graph.fingerprint,
        assumptions: task.graph.assumptions,
        risks: task.graph.risks,
        evidence: task.graph.evidence,
        slices: task.graph.slices,
      }),
    );
    this.tasks.transition(
      task,
      "awaiting_approval",
      "Immutable plan snapshot is ready for human approval.",
      { fingerprint: task.graph.fingerprint },
    );
    notifyProgress(onProgress, "Plan is ready for approval.");
    return task;
  }

  approve(id: string): TaskRecord {
    const task = this.tasks.load(id);
    if (task.status !== "awaiting_approval" || !task.graph) {
      throw new Error(`Task ${id} has no plan awaiting approval.`);
    }
    const actualFingerprint = sliceGraphFingerprint(task.graph);
    if (task.graph.fingerprint !== actualFingerprint) {
      throw new Error(`Task ${id} plan fingerprint does not match its current Slice Graph.`);
    }
    const costLimit = this.config.routing?.maxEstimatedCostUSD;
    if (
      costLimit !== undefined &&
      task.graph.estimatedCostUSD !== undefined &&
      task.graph.estimatedCostUSD > costLimit
    ) {
      throw new Error(
        `Task ${id} estimated cost $${task.graph.estimatedCostUSD.toFixed(2)} exceeds routing ceiling $${costLimit.toFixed(2)}. Revise the plan or raise the ceiling explicitly.`,
      );
    }
    task.approvedFingerprint = task.graph.fingerprint;
    const queue: QueueItem = {
      taskId: id,
      priority: task.request.priority,
      dependencies: [],
      attempts: 0,
      maxAttempts: this.config.execution?.maxRepairAttempts ?? 3,
      budget: { maxDurationMs: this.config.execution?.taskTimeoutMs ?? 60 * 60 * 1000 },
      enqueuedAt: new Date().toISOString(),
    };
    task.queue = queue;
    this.tasks.transition(task, "queued", "Plan approved and queued for isolated execution.");
    return task;
  }

  async revise(id: string, feedback: string): Promise<TaskRecord> {
    const task = this.tasks.load(id);
    if (
      !["awaiting_approval", "needs_attention", "ready_to_promote", "failed", "blocked"].includes(
        task.status,
      )
    ) {
      throw new Error(`Task ${id} cannot be revised in status ${task.status}.`);
    }
    if (!feedback.trim()) throw new Error("Revision feedback cannot be empty.");
    task.revision += 1;
    task.packet.decisions.push({
      questionId: `revision-${task.revision}`,
      answer: feedback.trim(),
    });
    task.request.constraints.push(`Revision ${task.revision}: ${feedback.trim()}`);
    try {
      task.packet = await this.packet(task, task.packet);
    } catch (error) {
      task.lastError = error instanceof Error ? error.message : String(error);
      this.tasks.transition(task, "failed", "Structured clarification failed during revision.", {
        error: task.lastError,
      });
      throw new Error(`Task ${task.taskId} clarification failed: ${task.lastError}`);
    }
    task.graph = undefined;
    task.queue = undefined;
    task.evidence = [];
    task.supersededRunIds = [...new Set([...(task.supersededRunIds ?? []), ...task.runIds])];
    task.runIds = [];
    task.approvedFingerprint = undefined;
    const previousExecution = task.execution;
    task.execution = undefined;
    if (previousExecution) {
      const git = new GitService(this.projectRoot);
      try {
        await git.removeWorktree(previousExecution.stagingWorktreePath, true);
        await git.deleteBranch(previousExecution.stagingBranch);
      } catch {
        // The new revision is safe; clean can prune already-missing or stale staging metadata.
      }
    }
    if (task.packet.blockers.length) {
      this.tasks.transition(
        task,
        "clarifying",
        "Revision feedback recorded; clarification is required.",
      );
      return task;
    }
    this.tasks.transition(
      task,
      "ready_to_plan",
      "Revision feedback recorded; rebuilding the task plan.",
    );
    return this.plan(task);
  }

  cancel(id: string): TaskRecord {
    const task = this.tasks.load(id);
    if (task.status === "promoted") throw new Error("A promoted task cannot be cancelled.");
    this.tasks.transition(task, "cancelled", "Task cancelled by user.");
    return task;
  }
}
