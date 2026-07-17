import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type { EvaluationTrial, SliceForgeConfig } from "../../src/core/contracts";
import { EvaluationEngine, calculateEvaluationMetrics } from "../../src/core/evaluation";
import { runProcess } from "../../src/core/process-runner";
import { RuntimeStore } from "../../src/core/runtime-store";
import { sliceGraphFingerprint, TaskEngine } from "../../src/core/task-engine";

const roots: string[] = [];
jest.setTimeout(60_000);

function temporaryDirectory(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-task-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function config(): SliceForgeConfig {
  const agent = { type: "codex" as const };
  return {
    schemaVersion: 1,
    project: "task-fixture",
    agents: {
      implementer: agent,
      testgen: agent,
      reviewer: agent,
    },
    targets: {
      app: {
        root: ".",
        preset: "node",
        commands: { unit: { command: process.execPath, args: ["-e", "process.exit(0)"] } },
      },
    },
    isolation: { mode: "worktree" },
    gates: {
      order: ["unit"],
      browser: { enabled: false },
      review: { enabled: false, advisory: true },
    },
    policies: { protectedPatterns: ["**/.env*"], maxRetries: 2 },
    routing: { fallbackRole: "implementer" },
    execution: {
      concurrency: 1,
      taskTimeoutMs: 60_000,
      maxRepairAttempts: 3,
      maxRepeatedFailure: 2,
      leaseMs: 10_000,
    },
    evaluation: {
      repetitions: 2,
      contextVariants: ["original", "reduced"],
      maxSuccessRateRegression: 0.05,
      requireSchemaCompliance: true,
    },
    inputs: { maxAttachmentBytes: 1024 * 1024 },
    documentation: { defaultImpact: "review", requireReviewWhenUncertain: true },
    reporting: { retainRuns: 10, maxLogBytes: 65536 },
    ci: { reportOnly: true },
  };
}

function evaluationRuntime(root: string): RuntimeStore {
  return new RuntimeStore({
    root: path.join(root, "runtime"),
    runs: path.join(root, "runtime", "runs"),
    tasks: path.join(root, "runtime", "tasks"),
    evaluations: path.join(root, "runtime", "evaluations"),
    reports: path.join(root, "runtime", "reports"),
    worktrees: path.join(root, "runtime", "worktrees"),
  });
}

async function project(): Promise<string> {
  const root = temporaryDirectory();
  fs.writeFileSync(path.join(root, "sliceforge.config.jsonc"), JSON.stringify(config(), null, 2));
  const result = await runProcess(
    { command: "git", args: ["init"], timeoutMs: 10_000 },
    { root, maxOutputBytes: 65536 },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr);
  for (const args of [
    ["config", "user.email", "sliceforge@example.invalid"],
    ["config", "user.name", "SliceForge Test"],
    ["add", "."],
    ["commit", "-m", "fixture base"],
  ]) {
    const git = await runProcess(
      { command: "git", args, timeoutMs: 10_000 },
      { root, maxOutputBytes: 65536 },
    );
    if (git.exitCode !== 0) throw new Error(git.stderr);
  }
  return root;
}

async function commitAll(root: string, message: string): Promise<void> {
  for (const args of [
    ["add", "."],
    ["commit", "-m", message],
  ]) {
    const result = await runProcess(
      { command: "git", args, timeoutMs: 10_000 },
      { root, maxOutputBytes: 65536 },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
}

async function configurePlanningAgent(root: string, source: string): Promise<void> {
  const script = path.join(root, "planning-agent.cjs");
  fs.writeFileSync(script, source);
  const configPath = path.join(root, "sliceforge.config.jsonc");
  const value = JSON.parse(fs.readFileSync(configPath, "utf8")) as SliceForgeConfig;
  const definition = {
    type: "command" as const,
    command: process.execPath,
    args: ["planning-agent.cjs"],
    capabilities: ["clarifier" as const, "planner" as const],
  };
  value.agents.clarifier = definition;
  value.agents.planner = definition;
  fs.writeFileSync(configPath, JSON.stringify(value, null, 2));
  await commitAll(root, "configure planning agent");
}

const structuredPlanningAgent = `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const output = request.role === "clarifier"
    ? { kind: "clarification", readinessScore: 95, questions: [], assumptions: ["Use existing repository conventions."], blockers: [] }
    : {
        kind: "plan",
        slices: [
          {
            id: "user-api",
            title: "Implement the user API contract",
            priority: 1,
            targets: ["app"],
            acceptance: [{ id: "USER-API-001", expected: "The user API behavior passes unit tests." }],
            allowedPaths: ["src/api/**", "tests/api/**"],
            requiredGates: ["unit"],
            evidence: [{ acceptanceId: "USER-API-001", kind: "test", source: "unit", required: true }]
          },
          {
            id: "user-ui",
            title: "Implement the user interface",
            priority: 2,
            dependsOn: ["user-api"],
            targets: ["app"],
            acceptance: [{ id: "USER-UI-001", expected: "The user interface behavior passes unit tests." }],
            allowedPaths: ["src/ui/**", "tests/ui/**"],
            requiredGates: ["unit"],
            evidence: [{ acceptanceId: "USER-UI-001", kind: "test", source: "unit", required: true }]
          }
        ],
        assumptions: ["The API and UI can be verified independently."],
        risks: ["No browser gate is configured."],
        estimatedCostUSD: 0.25
      };
  process.stdout.write(JSON.stringify({
    protocolVersion: "1.0",
    status: "completed",
    summary: request.role + " completed",
    artifacts: [],
    commandsRun: [],
    diagnostics: [],
    output
  }));
});
`;

describe("task intake, clarification and approval", () => {
  it("blocks a vague UI request and plans only after every answer is recorded", async () => {
    const engine = await TaskEngine.open(await project());
    const draft = await engine.create("Làm màn hình A");
    expect(draft.status).toBe("clarifying");
    expect(draft.packet.questions.length).toBeGreaterThan(0);
    expect(draft.graph).toBeUndefined();

    const answers = Object.fromEntries(
      draft.packet.questions.map((question) => [question.id, question.recommendation]),
    );
    const planned = await engine.answer(draft.taskId, answers);
    expect(planned.status).toBe("awaiting_approval");
    expect(planned.graph?.slices).toHaveLength(1);
    expect(planned.graph?.evidence).toHaveLength(1);
    expect(
      fs.existsSync(path.join(engine.tasks.directory(planned.taskId), "plan-revision-2.yaml")),
    ).toBe(true);

    const originalFingerprint = planned.graph?.fingerprint;
    const revised = await engine.revise(planned.taskId, "Use a compact responsive table layout.");
    expect(revised.status).toBe("awaiting_approval");
    expect(revised.revision).toBe(3);
    expect(revised.graph?.fingerprint).not.toBe(originalFingerprint);
    expect(
      fs.existsSync(path.join(engine.tasks.directory(planned.taskId), "plan-revision-3.yaml")),
    ).toBe(true);

    const queued = engine.approve(revised.taskId);
    expect(queued.status).toBe("queued");
    expect(queued.approvedFingerprint).toBe(queued.graph?.fingerprint);
  });

  it("creates a decision-ready API task with documentation evidence", async () => {
    const engine = await TaskEngine.open(await project());
    const task = await engine.create(
      "Cho phép người dùng tạo tài khoản qua API POST /users với field email, phải trả lỗi 409 và có unit test.",
    );
    expect(task.status).toBe("awaiting_approval");
    expect(task.packet.readinessScore).toBeGreaterThanOrEqual(80);
    expect(task.graph?.slices[0]).toMatchObject({ docsImpact: "required" });
    expect(task.graph?.slices[0].requiredArtifacts).toEqual(
      expect.arrayContaining([expect.stringMatching(/^docs\/tasks\//)]),
    );
  });

  it("uses strict clarifier and planner responses to create a validated multi-slice graph", async () => {
    const root = await project();
    await configurePlanningAgent(root, structuredPlanningAgent);
    const engine = await TaskEngine.open(root);
    const intake = await engine.create(
      "Allow users to create accounts through API POST /users with email field, render loading and error states in the UI, and verify behavior with unit tests.",
    );
    expect(intake.status).toBe("clarifying");
    const task = await engine.answer(
      intake.taskId,
      Object.fromEntries(
        intake.packet.questions.map((question) => [question.id, question.recommendation]),
      ),
    );

    expect(task.status).toBe("awaiting_approval");
    expect(task.graph?.slices.map((slice) => slice.id)).toEqual(["user-api", "user-ui"]);
    expect(task.graph?.slices[1].dependsOn).toEqual(["user-api"]);
    expect(task.graph?.evidence).toHaveLength(2);
    expect(task.graph?.estimatedCostUSD).toBe(0.25);
    expect(task.planningAgentResponses?.clarifier?.output?.kind).toBe("clarification");
    expect(task.planningAgentResponses?.planner?.output?.kind).toBe("plan");
    expect(task.graph?.fingerprint).toBe(sliceGraphFingerprint(task.graph!));
    const status = await runProcess(
      { command: "git", args: ["status", "--porcelain"], timeoutMs: 10_000 },
      { root, maxOutputBytes: 65536 },
    );
    expect(status.stdout.trim()).toBe("");
  });

  it("preserves engine-owned image references in every structured planner slice", async () => {
    const root = await project();
    await configurePlanningAgent(root, structuredPlanningAgent);
    const image = path.join(root, "screen.png");
    fs.writeFileSync(image, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]));
    const engine = await TaskEngine.open(root);
    const intake = await engine.create(
      "Implement the approved user interface with loading and error states, use the existing API contract, and verify behavior with unit tests.",
      { images: ["screen.png"] },
    );
    const task =
      intake.status === "clarifying"
        ? await engine.answer(
            intake.taskId,
            Object.fromEntries(
              intake.packet.questions.map((question) => [question.id, question.recommendation]),
            ),
          )
        : intake;
    expect(task.status).toBe("awaiting_approval");
    expect(task.graph?.slices.every((slice) => slice.description?.includes("Engine-owned"))).toBe(
      true,
    );
    expect(
      task.graph?.slices.every((slice) => slice.description?.includes('"kind": "image"')),
    ).toBe(true);
    expect(task.request.attachments[0]).toMatchObject({ kind: "image", source: "screen.png" });
  });

  it("fails closed when planner output violates target scope", async () => {
    const root = await project();
    await configurePlanningAgent(
      root,
      structuredPlanningAgent.replace(
        'targets: ["app"],\n            acceptance:',
        'targets: ["outside"],\n            acceptance:',
      ),
    );
    const engine = await TaskEngine.open(root);
    await expect(
      engine.create(
        "Allow users to create accounts through API POST /users with email field and verify behavior with unit tests.",
      ),
    ).rejects.toThrow(/planning failed.*unknown target/i);
    expect(engine.tasks.list()).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "failed" })]),
    );
  });

  it("contains a mutating clarifier inside a disposable worktree and rejects its result", async () => {
    const root = await project();
    await configurePlanningAgent(
      root,
      structuredPlanningAgent.replace(
        "const request = JSON.parse(input);",
        'const request = JSON.parse(input); require("fs").writeFileSync("agent-mutation.txt", "unsafe");',
      ),
    );
    const engine = await TaskEngine.open(root);
    await expect(
      engine.create(
        "Allow users to create accounts through API POST /users with email field and verify behavior with unit tests.",
      ),
    ).rejects.toThrow(/mutated its read-only planning worktree/i);
    expect(fs.existsSync(path.join(root, "agent-mutation.txt"))).toBe(false);
    const status = await runProcess(
      { command: "git", args: ["status", "--porcelain"], timeoutMs: 10_000 },
      { root, maxOutputBytes: 65536 },
    );
    expect(status.stdout.trim()).toBe("");
  });

  it("does not silently fall back when a configured clarifier returns malformed output", async () => {
    const root = await project();
    await configurePlanningAgent(
      root,
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write("{}"));',
    );
    const engine = await TaskEngine.open(root);
    await expect(
      engine.create(
        "Allow users to create accounts through API POST /users with email field and verify behavior with unit tests.",
      ),
    ).rejects.toThrow(/clarification failed.*schema validation/i);
    const failed = engine.tasks.list()[0];
    expect(failed.status).toBe("failed");
    expect(failed.graph).toBeUndefined();
  });

  it("blocks approval when planner estimated cost exceeds the configured ceiling", async () => {
    const root = await project();
    const configPath = path.join(root, "sliceforge.config.jsonc");
    const value = JSON.parse(fs.readFileSync(configPath, "utf8")) as SliceForgeConfig;
    value.routing = { ...value.routing!, maxEstimatedCostUSD: 0.1 };
    fs.writeFileSync(configPath, JSON.stringify(value, null, 2));
    await configurePlanningAgent(root, structuredPlanningAgent);
    const engine = await TaskEngine.open(root);
    const task = await engine.create(
      "Allow users to create accounts through API POST /users with email field, return 409 for duplicates, and verify behavior with unit tests.",
    );
    expect(task.status).toBe("awaiting_approval");
    expect(() => engine.approve(task.taskId)).toThrow(/estimated cost.*exceeds routing ceiling/i);
    expect(engine.tasks.load(task.taskId).status).toBe("awaiting_approval");
  });

  it("rejects hostile or mislabeled external inputs before planning", async () => {
    const root = await project();
    const engine = await TaskEngine.open(root);
    fs.writeFileSync(path.join(root, "not-an-image.png"), "plain text");
    await expect(
      engine.create("Implement the approved user interface with deterministic tests.", {
        images: ["not-an-image.png"],
      }),
    ).rejects.toThrow(/unsupported or invalid image/i);
    await expect(
      engine.create("Implement the approved Figma user interface with deterministic tests.", {
        figma: "https://example.com/fake-figma",
      }),
    ).rejects.toThrow(/figma\.com hostname/i);

    const configPath = path.join(root, "sliceforge.config.jsonc");
    const configured = JSON.parse(fs.readFileSync(configPath, "utf8")) as SliceForgeConfig;
    configured.inputs = {
      maxAttachmentBytes: 1024 * 1024,
      figmaProvider: {
        command: process.execPath,
        args: [
          "-e",
          "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('{\"frame\":1,\"frame\":2}'))",
        ],
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(configured, null, 2));
    const strictEngine = await TaskEngine.open(root);
    await expect(
      strictEngine.create("Implement the approved Figma user interface with deterministic tests.", {
        figma: "https://www.figma.com/design/fixture",
      }),
    ).rejects.toThrow(/exactly one JSON document/i);
  });

  it("builds a bounded repository context pack without reading protected or unsafe files", async () => {
    const root = await project();
    fs.mkdirSync(path.join(root, "docs"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "api"), { recursive: true });
    fs.writeFileSync(path.join(root, "AGENTS.md"), "Follow the repository API conventions.\n");
    fs.writeFileSync(path.join(root, "docs", "users.md"), "The users endpoint creates accounts.\n");
    fs.writeFileSync(
      path.join(root, "src", "api", "openapi.yaml"),
      "paths:\n  /users:\n    post:\n      responses:\n        '201': { description: created }\n",
    );
    fs.writeFileSync(path.join(root, ".env.local"), "API_SECRET=must-not-be-read\n");
    fs.writeFileSync(path.join(root, "docs", "binary.txt"), Buffer.from([0, 1, 2, 3]));
    fs.writeFileSync(path.join(root, "docs", "too-large.md"), "x".repeat(129 * 1024));
    const outside = path.join(temporaryDirectory(), "outside.md");
    fs.writeFileSync(outside, "outside secret context\n");
    try {
      fs.symlinkSync(outside, path.join(root, "docs", "outside-link.md"), "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    await commitAll(root, "add repository context fixtures");

    const engine = await TaskEngine.open(root);
    const first = await engine.create(
      "Allow users to create accounts through API POST /users with email field, return 409 for duplicates, and verify behavior with unit tests.",
    );
    const files = first.packet.contextSummary.files;
    expect(files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "AGENTS.md", kind: "convention" }),
        expect.objectContaining({ path: "docs/users.md", kind: "documentation" }),
        expect.objectContaining({ path: "src/api/openapi.yaml", kind: "api-schema" }),
      ]),
    );
    expect(files.map((entry) => entry.path)).not.toEqual(
      expect.arrayContaining([
        ".env.local",
        "docs/binary.txt",
        "docs/too-large.md",
        "docs/outside-link.md",
      ]),
    );
    expect(files.length).toBeLessThanOrEqual(40);
    expect(files.every((entry) => entry.snippet.length <= 2048 && entry.sha256.length === 64)).toBe(
      true,
    );
    expect(
      files.reduce((total, entry) => total + Buffer.byteLength(entry.snippet, "utf8"), 0),
    ).toBeLessThanOrEqual(64 * 1024);

    fs.appendFileSync(path.join(root, "src", "api", "openapi.yaml"), "      x-updated: true\n");
    const second = await engine.create(
      "Allow users to create accounts through API POST /users with email field, return 409 for duplicates, and verify behavior with unit tests.",
    );
    expect(second.packet.contextFingerprint).not.toBe(first.packet.contextFingerprint);
  });

  it("blocks long but low-information requests and detects graph mutation", async () => {
    const engine = await TaskEngine.open(await project());
    const vague = await engine.create(
      "Please improve the application experience across the entire product in a modern and professional way.",
    );
    expect(vague.status).toBe("clarifying");
    expect(vague.packet.blockers).toContain("readiness-gap");

    const clear = await engine.create(
      "Allow users to create accounts through API POST /users with email field, return 409 for duplicates, and verify it with unit tests.",
    );
    expect(clear.status).toBe("awaiting_approval");
    clear.graph!.slices.push({
      ...clear.graph!.slices[0],
      id: `${clear.graph!.slices[0].id}-second`,
    });
    engine.tasks.save(clear);
    expect(() => engine.approve(clear.taskId)).toThrow(/fingerprint does not match/i);
    clear.graph!.fingerprint = sliceGraphFingerprint(clear.graph!);
    engine.tasks.save(clear);
    expect(engine.approve(clear.taskId).status).toBe("queued");
  });

  it("recovers task state from the journal and repairs a partial tail", async () => {
    const engine = await TaskEngine.open(await project());
    const task = await engine.create(
      "Allow users to create accounts through API POST /users with email field, return 409 for duplicates, and verify it with unit tests.",
    );
    const eventPath = path.join(engine.tasks.directory(task.taskId), "events.jsonl");
    const snapshot = { ...task, status: "cancelled" as const, sequence: task.sequence + 1 };
    fs.appendFileSync(
      eventPath,
      `${JSON.stringify({ sequence: snapshot.sequence, timestamp: new Date().toISOString(), status: snapshot.status, message: "crash", data: { snapshot } })}\n`,
    );
    expect(engine.tasks.load(task.taskId)).toMatchObject({
      status: "cancelled",
      sequence: snapshot.sequence,
    });

    const second = await engine.create(
      "Allow users to update profiles through API PATCH /users with email field, return 400 for invalid data, and verify it with unit tests.",
    );
    const secondEventPath = path.join(engine.tasks.directory(second.taskId), "events.jsonl");
    fs.appendFileSync(secondEventPath, '{"sequence":');
    expect(engine.tasks.events(second.taskId)).toHaveLength(second.sequence);
    engine.cancel(second.taskId);
    expect(engine.tasks.events(second.taskId).at(-1)?.status).toBe("cancelled");
  });
});

describe("evaluation metrics and repeat protocol", () => {
  it("calculates consistency and evidence metrics", () => {
    const base: EvaluationTrial = {
      caseId: "case-a",
      contextVariant: "original",
      success: true,
      schemaCompliant: true,
      policyViolations: 0,
      unsupportedClaims: 0,
      claimsTotal: 1,
      acceptanceVerified: 2,
      acceptanceTotal: 2,
      retries: 1,
      durationMs: 100,
      costUSD: 0.1,
      behaviorFingerprint: "same",
      changedFilesFingerprint: "files",
      flakyGates: 0,
      secretLeaks: 0,
    };
    const metrics = calculateEvaluationMetrics([
      base,
      { ...base, behaviorFingerprint: "different" },
    ]);
    expect(metrics.taskSuccessRate).toBe(1);
    expect(metrics.acceptanceVerificationRate).toBe(1);
    expect(metrics.behaviorVarianceRate).toBe(1);
    expect(metrics.changedFileVarianceRate).toBe(0);
    expect(metrics.contextBehaviorVarianceRate).toBe(0);
    expect(metrics.contextChangedFileVarianceRate).toBe(0);
    expect(metrics.unsupportedClaimRate).toBe(0);
    expect(metrics.totalCostUSD).toBeCloseTo(0.2);
  });

  it("measures unsupported claims against the actual claim count", () => {
    const trial: EvaluationTrial = {
      caseId: "case-a",
      contextVariant: "original",
      success: false,
      schemaCompliant: true,
      policyViolations: 0,
      unsupportedClaims: 1,
      claimsTotal: 4,
      acceptanceVerified: 10,
      acceptanceTotal: 10,
      retries: 0,
      durationMs: 1,
      costUSD: 0,
      behaviorFingerprint: "behavior",
      changedFilesFingerprint: "files",
      flakyGates: 0,
      secretLeaks: 0,
    };
    expect(calculateEvaluationMetrics([trial]).unsupportedClaimRate).toBe(0.25);
  });

  it("runs every configured repetition and context variant", async () => {
    const root = temporaryDirectory();
    const runtime = evaluationRuntime(root);
    const payload = {
      acceptance: [{ id: "AC-1", verified: true, evidence: ["unit:test"] }],
      claims: [{ statement: "The acceptance test passed", evidence: ["unit:test"] }],
      changedFiles: ["src/result.ts"],
      gates: [{ id: "unit:test", status: "passed" }],
      retries: 0,
      costUSD: 0,
      output: { status: "stable" },
    };
    fs.writeFileSync(
      path.join(root, "suite.json"),
      JSON.stringify({
        name: "stable-suite",
        command: {
          command: process.execPath,
          args: [
            "-e",
            `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(payload))}))`,
          ],
        },
        cases: [{ id: "case-a", input: { request: "test" }, allowedPaths: ["src/**"] }],
      }),
    );
    const record = await new EvaluationEngine(root, config(), runtime).run("suite.json");
    expect(record.trials).toHaveLength(4);
    expect(record.regression).toEqual({ passed: true, reasons: [] });
  });

  it("records malformed evaluator output as failed trials instead of aborting the suite", async () => {
    const root = temporaryDirectory();
    const runtime = evaluationRuntime(root);
    fs.writeFileSync(
      path.join(root, "invalid-suite.json"),
      JSON.stringify({
        name: "invalid-suite",
        command: {
          command: process.execPath,
          args: [
            "-e",
            "process.stdin.resume();process.stdin.on('end',()=>console.log('{\\\"a\\\":1,\\\"a\\\":2}'))",
          ],
        },
        cases: [{ id: "case-a", input: {} }],
        contextVariants: ["original"],
      }),
    );
    const record = await new EvaluationEngine(root, config(), runtime).run("invalid-suite.json");
    expect(record.trials).toHaveLength(2);
    expect(record.trials.every((trial) => !trial.schemaCompliant && !trial.success)).toBe(true);
    expect(record.regression.passed).toBe(false);
  });

  it("reports model drift without failing a valid regression run", async () => {
    const root = temporaryDirectory();
    const runtime = evaluationRuntime(root);
    const suitePath = path.join(root, "provenance-suite.json");
    const payload = {
      acceptance: [{ id: "AC-1", verified: true, evidence: ["unit:test"] }],
      claims: [{ statement: "The test passed", evidence: ["unit:test"] }],
      changedFiles: ["src/result.ts"],
      gates: [{ id: "unit:test", status: "passed" }],
      retries: 0,
      costUSD: 0,
      output: { status: "stable" },
    };
    const suite = {
      name: "provenance-suite",
      command: {
        command: process.execPath,
        args: [
          "-e",
          `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(payload))}))`,
        ],
      },
      cases: [
        { id: "case-a", input: { request: "test" }, allowedPaths: ["src/**"], repetitions: 1 },
      ],
      contextVariants: ["original"],
      agentVersions: { planner: "model-v1" },
    };
    fs.writeFileSync(suitePath, JSON.stringify(suite));

    const engine = new EvaluationEngine(root, config(), runtime);
    const baselineRecord = await engine.run("provenance-suite.json");
    engine.acceptBaseline(baselineRecord.evaluationId);
    fs.writeFileSync(
      suitePath,
      JSON.stringify({ ...suite, agentVersions: { planner: "model-v2" } }),
    );

    const current = await engine.run("provenance-suite.json", "default");
    expect(current.regression.passed).toBe(true);
    expect(current.regression.drift).toMatchObject({
      agentVersionsChanged: true,
      configChanged: false,
      contextChanged: false,
    });
    expect(current.regression.drift?.agentVersionChanges).toEqual([
      "planner: model-v1 -> model-v2",
    ]);
  });

  it("rejects baseline comparisons when context or harness policy changed", async () => {
    const root = temporaryDirectory();
    const runtime = evaluationRuntime(root);
    const suitePath = path.join(root, "drift-suite.json");
    const payload = {
      acceptance: [{ id: "AC-1", verified: true, evidence: ["unit:test"] }],
      claims: [],
      changedFiles: [],
      gates: [{ id: "unit:test", status: "passed" }],
      retries: 0,
      costUSD: 0,
      output: { status: "stable" },
    };
    const suite = {
      name: "drift-suite",
      command: {
        command: process.execPath,
        args: [
          "-e",
          `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(payload))}))`,
        ],
      },
      cases: [{ id: "case-a", input: {}, repetitions: 1 }],
      contextVariants: ["original"],
      agentVersions: { planner: "model-v1" },
    };
    fs.writeFileSync(suitePath, JSON.stringify(suite));
    const engine = new EvaluationEngine(root, config(), runtime);
    const accepted = await engine.run("drift-suite.json");
    engine.acceptBaseline(accepted.evaluationId);

    fs.writeFileSync(suitePath, JSON.stringify({ ...suite, contextFingerprint: "new-context" }));
    const contextDrift = await engine.run("drift-suite.json", "default");
    expect(contextDrift.regression.passed).toBe(false);
    expect(contextDrift.regression.reasons).toContain(
      "Evaluation context fingerprint changed from baseline.",
    );

    fs.writeFileSync(suitePath, JSON.stringify(suite));
    const changedConfig = config();
    changedConfig.execution = { ...changedConfig.execution!, concurrency: 2 };
    const configDrift = await new EvaluationEngine(root, changedConfig, runtime).run(
      "drift-suite.json",
      "default",
    );
    expect(configDrift.regression.passed).toBe(false);
    expect(configDrift.regression.reasons).toContain(
      "Harness configuration fingerprint changed from baseline.",
    );
  });

  it("flags inconsistent behavior and changed files without requiring a baseline", async () => {
    const root = temporaryDirectory();
    const runtime = evaluationRuntime(root);
    const script = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const request=JSON.parse(input);const odd=request.repetition%2===1;console.log(JSON.stringify({acceptance:[{id:'AC-1',verified:true,evidence:['unit:test']}],claims:[],changedFiles:[odd?'src/b.ts':'src/a.ts'],gates:[{id:'unit:test',status:'passed'}],retries:0,costUSD:0,output:{variant:odd?'b':'a'}}));});`;
    fs.writeFileSync(
      path.join(root, "variance-suite.json"),
      JSON.stringify({
        name: "variance-suite",
        command: { command: process.execPath, args: ["-e", script] },
        cases: [{ id: "case-a", input: {}, repetitions: 2, allowedPaths: ["src/**"] }],
        contextVariants: ["original"],
        agentVersions: { planner: "model-v1" },
      }),
    );
    const record = await new EvaluationEngine(root, config(), runtime).run("variance-suite.json");
    expect(record.metrics.behaviorVarianceRate).toBe(1);
    expect(record.metrics.changedFileVarianceRate).toBe(1);
    expect(record.regression.passed).toBe(false);
    expect(record.regression.reasons).toEqual(
      expect.arrayContaining([
        "Repeated trials produced inconsistent behavior.",
        "Repeated trials changed inconsistent file sets.",
      ]),
    );
  });

  it("owns context perturbation and blocks cross-variant behavior drift", async () => {
    const root = temporaryDirectory();
    const runtime = evaluationRuntime(root);
    const requests = path.join(root, "variant-requests.jsonl");
    const script = `let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const request=JSON.parse(input);require('fs').appendFileSync(${JSON.stringify(requests)},JSON.stringify(request)+'\\n');console.log(JSON.stringify({acceptance:[{id:'AC-1',verified:true,evidence:['unit:test']}],claims:[],changedFiles:['src/result.ts'],gates:[{id:'unit:test',status:'passed'}],retries:0,costUSD:0,output:{context:request.context}}));});`;
    fs.writeFileSync(
      path.join(root, "context-suite.json"),
      JSON.stringify({
        name: "context-suite",
        command: { command: process.execPath, args: ["-e", script] },
        cases: [
          {
            id: "case-a",
            input: { request: "test" },
            context: ["first", "second", "third"],
            irrelevantContext: ["unrelated"],
            repetitions: 1,
            allowedPaths: ["src/**"],
          },
        ],
        contextVariants: ["original", "reordered", "irrelevant", "reduced"],
        agentVersions: { planner: "model-v1" },
      }),
    );
    const record = await new EvaluationEngine(root, config(), runtime).run("context-suite.json");
    const received = fs
      .readFileSync(requests, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as { contextVariant: string; context: unknown[] });
    expect(received.map((item) => [item.contextVariant, item.context])).toEqual([
      ["original", ["first", "second", "third"]],
      ["reordered", ["third", "second", "first"]],
      ["irrelevant", ["first", "second", "third", "unrelated"]],
      ["reduced", ["first", "second"]],
    ]);
    expect(record.metrics.behaviorVarianceRate).toBe(0);
    expect(record.metrics.contextBehaviorVarianceRate).toBe(1);
    expect(record.metrics.contextChangedFileVarianceRate).toBe(0);
    expect(record.regression.passed).toBe(false);
    expect(record.regression.reasons).toContain("Context variants produced inconsistent behavior.");
  });

  it("blocks unsupported claims, flaky gates and failed gates independently of a baseline", async () => {
    const root = temporaryDirectory();
    const runtime = evaluationRuntime(root);
    const payload = {
      acceptance: [{ id: "AC-1", verified: true, evidence: ["unit:test"] }],
      claims: [{ statement: "Unsupported claim", evidence: [] }],
      changedFiles: [],
      gates: [
        { id: "unit:test", status: "failed" },
        { id: "integration:test", status: "flaky" },
      ],
      retries: 0,
      costUSD: 0,
      output: { status: "failed" },
    };
    fs.writeFileSync(
      path.join(root, "unsafe-suite.json"),
      JSON.stringify({
        name: "unsafe-suite",
        command: {
          command: process.execPath,
          args: [
            "-e",
            `process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(payload))}))`,
          ],
        },
        cases: [{ id: "case-a", input: {}, repetitions: 1 }],
        contextVariants: ["original"],
        agentVersions: { planner: "model-v1" },
      }),
    );
    const record = await new EvaluationEngine(root, config(), runtime).run("unsafe-suite.json");
    expect(record.regression.passed).toBe(false);
    expect(record.regression.reasons).toEqual(
      expect.arrayContaining([
        "At least one evaluation trial failed.",
        "At least one agent claim has no supporting evidence.",
        "At least one deterministic gate is flaky.",
      ]),
    );
  });

  it("rejects a missing baseline before executing the evaluation command", async () => {
    const root = temporaryDirectory();
    const marker = path.join(root, "command-executed.txt");
    fs.writeFileSync(
      path.join(root, "missing-baseline-suite.json"),
      JSON.stringify({
        name: "missing-baseline-suite",
        command: {
          command: process.execPath,
          args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
        },
        cases: [{ id: "case-a", input: {}, repetitions: 1 }],
        contextVariants: ["original"],
        agentVersions: { planner: "model-v1" },
      }),
    );
    await expect(
      new EvaluationEngine(root, config(), evaluationRuntime(root)).run(
        "missing-baseline-suite.json",
        "missing",
      ),
    ).rejects.toThrow("Evaluation baseline not found: missing");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("rejects malformed, duplicate and symlinked suites before evaluator execution", async () => {
    const root = temporaryDirectory();
    const runtime = evaluationRuntime(root);
    const marker = path.join(root, "schema-command-executed.txt");
    const command = {
      command: process.execPath,
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
    };
    fs.writeFileSync(
      path.join(root, "unknown-field-suite.json"),
      JSON.stringify({
        name: "unknown-field-suite",
        command,
        cases: [{ id: "case-a", input: {} }],
        trustedByAgent: true,
      }),
    );
    const engine = new EvaluationEngine(root, config(), runtime);
    await expect(engine.run("unknown-field-suite.json")).rejects.toThrow(
      /Invalid evaluation suite.*additional properties/i,
    );

    fs.writeFileSync(
      path.join(root, "duplicate-key-suite.json"),
      '{"name":"first","name":"second","command":{"command":"node"},"cases":[{"id":"case-a","input":{}}]}',
    );
    await expect(engine.run("duplicate-key-suite.json")).rejects.toThrow(
      /Failed to parse evaluation suite.*duplicate key/i,
    );

    fs.writeFileSync(
      path.join(root, "duplicate-suite.json"),
      JSON.stringify({
        name: "duplicate-suite",
        command,
        cases: [
          { id: "case-a", input: {} },
          { id: "case-a", input: {} },
        ],
      }),
    );
    await expect(engine.run("duplicate-suite.json")).rejects.toThrow(
      "Duplicate evaluation case id: case-a",
    );
    expect(fs.existsSync(marker)).toBe(false);

    const outside = path.join(temporaryDirectory(), "outside-suite.json");
    fs.writeFileSync(
      outside,
      JSON.stringify({ name: "outside", command, cases: [{ id: "case-a", input: {} }] }),
    );
    try {
      fs.symlinkSync(outside, path.join(root, "suite-link.json"), "file");
      await expect(engine.run("suite-link.json")).rejects.toThrow(/non-symlink file/i);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
    expect(fs.existsSync(marker)).toBe(false);
  });
});
