import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type {
  CommandSpec,
  ContextVariant,
  EvaluationMetrics,
  EvaluationRecord,
  EvaluationTrial,
  SliceForgeConfig,
} from "./contracts.js";
import { runProcess } from "./process-runner.js";
import { atomicWrite, type RuntimeStore } from "./runtime-store.js";
import { parseStrictJson } from "./agent-protocol.js";
import { validateChangedPaths } from "./policy.js";
import { createValidator, loadSchema } from "./schema-loader.js";

const evaluationSuiteValidator = createValidator(
  loadSchema("../schemas/evaluation-suite.schema.json"),
);

export interface EvaluationSuiteCase {
  id: string;
  input: unknown;
  context?: unknown[];
  irrelevantContext?: unknown[];
  repetitions?: number;
  allowedPaths?: string[];
  protectedPatterns?: string[];
}

export interface EvaluationSuite {
  name: string;
  command: CommandSpec;
  cases: EvaluationSuiteCase[];
  contextVariants?: ContextVariant[];
  agentVersions?: Record<string, string>;
  contextFingerprint?: string;
}

interface EvaluationCommandResult {
  acceptance: Array<{ id: string; verified: boolean; evidence: string[] }>;
  claims: Array<{ statement: string; evidence: string[] }>;
  changedFiles: string[];
  gates: Array<{ id: string; status: "passed" | "failed" | "flaky" }>;
  retries: number;
  costUSD: number;
  output: unknown;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function calculateEvaluationMetrics(trials: EvaluationTrial[]): EvaluationMetrics {
  const totalAcceptance = trials.reduce((sum, trial) => sum + trial.acceptanceTotal, 0);
  const totalClaims = trials.reduce((sum, trial) => sum + trial.claimsTotal, 0);
  const behaviorGroups = new Map<string, Set<string>>();
  const changedFileGroups = new Map<string, Set<string>>();
  const caseBehaviorGroups = new Map<string, Map<ContextVariant, Set<string>>>();
  const caseChangedFileGroups = new Map<string, Map<ContextVariant, Set<string>>>();
  for (const trial of trials) {
    const key = `${trial.caseId}:${trial.contextVariant}`;
    const fingerprints = behaviorGroups.get(key) ?? new Set<string>();
    fingerprints.add(trial.behaviorFingerprint);
    behaviorGroups.set(key, fingerprints);
    const changedFiles = changedFileGroups.get(key) ?? new Set<string>();
    changedFiles.add(trial.changedFilesFingerprint);
    changedFileGroups.set(key, changedFiles);
    const caseBehaviors = caseBehaviorGroups.get(trial.caseId) ?? new Map();
    const variantBehaviors = caseBehaviors.get(trial.contextVariant) ?? new Set<string>();
    variantBehaviors.add(trial.behaviorFingerprint);
    caseBehaviors.set(trial.contextVariant, variantBehaviors);
    caseBehaviorGroups.set(trial.caseId, caseBehaviors);
    const caseChangedFiles = caseChangedFileGroups.get(trial.caseId) ?? new Map();
    const variantChangedFiles = caseChangedFiles.get(trial.contextVariant) ?? new Set<string>();
    variantChangedFiles.add(trial.changedFilesFingerprint);
    caseChangedFiles.set(trial.contextVariant, variantChangedFiles);
    caseChangedFileGroups.set(trial.caseId, caseChangedFiles);
  }
  const variableGroups = [...behaviorGroups.values()].filter((values) => values.size > 1).length;
  const changedFileVariableGroups = [...changedFileGroups.values()].filter(
    (values) => values.size > 1,
  ).length;
  const variesAcrossStableVariants = (variants: Map<ContextVariant, Set<string>>): boolean => {
    if (variants.size < 2 || [...variants.values()].some((values) => values.size !== 1))
      return false;
    return new Set([...variants.values()].map((values) => [...values][0])).size > 1;
  };
  const contextBehaviorVariableGroups = [...caseBehaviorGroups.values()].filter(
    variesAcrossStableVariants,
  ).length;
  const contextChangedFileVariableGroups = [...caseChangedFileGroups.values()].filter(
    variesAcrossStableVariants,
  ).length;
  return {
    taskSuccessRate: average(trials.map((trial) => (trial.success ? 1 : 0))),
    acceptanceVerificationRate: totalAcceptance
      ? trials.reduce((sum, trial) => sum + trial.acceptanceVerified, 0) / totalAcceptance
      : 0,
    schemaComplianceRate: average(trials.map((trial) => (trial.schemaCompliant ? 1 : 0))),
    policyViolationRate: average(trials.map((trial) => (trial.policyViolations ? 1 : 0))),
    unsupportedClaimRate: totalClaims
      ? trials.reduce((sum, trial) => sum + trial.unsupportedClaims, 0) / totalClaims
      : 0,
    flakyGateRate: average(trials.map((trial) => (trial.flakyGates ? 1 : 0))),
    behaviorVarianceRate: behaviorGroups.size ? variableGroups / behaviorGroups.size : 0,
    changedFileVarianceRate: changedFileGroups.size
      ? changedFileVariableGroups / changedFileGroups.size
      : 0,
    contextBehaviorVarianceRate: caseBehaviorGroups.size
      ? contextBehaviorVariableGroups / caseBehaviorGroups.size
      : 0,
    contextChangedFileVarianceRate: caseChangedFileGroups.size
      ? contextChangedFileVariableGroups / caseChangedFileGroups.size
      : 0,
    averageRetries: average(trials.map((trial) => trial.retries)),
    averageDurationMs: average(trials.map((trial) => trial.durationMs)),
    totalCostUSD: trials.reduce((sum, trial) => sum + trial.costUSD, 0),
  };
}

function validatePayload(value: unknown): EvaluationCommandResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Evaluation command must return one JSON object.");
  }
  const payload = value as Partial<EvaluationCommandResult>;
  const allowedKeys = new Set([
    "acceptance",
    "claims",
    "changedFiles",
    "gates",
    "retries",
    "costUSD",
    "output",
  ]);
  const unknownKeys = Object.keys(payload).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) {
    throw new Error(`Evaluation result has unknown field(s): ${unknownKeys.join(", ")}.`);
  }
  if (
    !Array.isArray(payload.acceptance) ||
    !payload.acceptance.length ||
    !payload.acceptance.every(
      (item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.verified === "boolean" &&
        Array.isArray(item.evidence) &&
        item.evidence.every((entry) => typeof entry === "string"),
    )
  ) {
    throw new Error("Evaluation result acceptance evidence is invalid.");
  }
  if (
    !Array.isArray(payload.claims) ||
    !payload.claims.every(
      (item) =>
        item &&
        typeof item.statement === "string" &&
        Array.isArray(item.evidence) &&
        item.evidence.every((entry) => typeof entry === "string"),
    )
  ) {
    throw new Error("Evaluation result claims are invalid.");
  }
  if (
    !Array.isArray(payload.changedFiles) ||
    !payload.changedFiles.every((item) => typeof item === "string")
  ) {
    throw new Error("Evaluation result changedFiles must be an array of strings.");
  }
  if (
    !Array.isArray(payload.gates) ||
    !payload.gates.every(
      (item) =>
        item && typeof item.id === "string" && ["passed", "failed", "flaky"].includes(item.status),
    )
  ) {
    throw new Error("Evaluation result gates are invalid.");
  }
  for (const key of ["retries", "costUSD"] as const) {
    if (!Number.isFinite(payload[key]) || Number(payload[key]) < 0) {
      throw new Error(`Evaluation result '${key}' must be a non-negative number.`);
    }
  }
  if (!("output" in payload)) throw new Error("Evaluation result output is required.");
  return payload as EvaluationCommandResult;
}

function fingerprint(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function contextForVariant(item: EvaluationSuiteCase, variant: ContextVariant): unknown[] {
  const source =
    item.context ??
    (item.input && typeof item.input === "object" && !Array.isArray(item.input)
      ? ((item.input as { context?: unknown[] }).context ?? [item.input])
      : [item.input]);
  const context = JSON.parse(JSON.stringify(source)) as unknown[];
  if (variant === "reordered") return [...context].reverse();
  if (variant === "irrelevant") {
    return [
      ...context,
      ...(item.irrelevantContext?.length
        ? JSON.parse(JSON.stringify(item.irrelevantContext))
        : [{ kind: "sliceforge-irrelevant-context", content: "Ignore this unrelated fixture." }]),
    ];
  }
  if (variant === "reduced") return context.slice(0, Math.max(0, context.length - 1));
  return context;
}

function failedTrial(
  caseId: string,
  contextVariant: ContextVariant,
  durationMs: number,
  rawOutput: string,
  secretLeaks: number,
): EvaluationTrial {
  return {
    caseId,
    contextVariant,
    success: false,
    schemaCompliant: false,
    policyViolations: 0,
    unsupportedClaims: 0,
    claimsTotal: 0,
    acceptanceVerified: 0,
    acceptanceTotal: 1,
    retries: 0,
    durationMs,
    costUSD: 0,
    behaviorFingerprint: fingerprint(rawOutput),
    changedFilesFingerprint: fingerprint([]),
    flakyGates: 0,
    secretLeaks,
  };
}

function regressionReasons(
  current: EvaluationMetrics,
  trials: EvaluationTrial[],
  baseline: EvaluationRecord | undefined,
  config: SliceForgeConfig,
  provenance?: Pick<
    EvaluationRecord,
    "suite" | "agentVersions" | "configFingerprint" | "contextFingerprint"
  >,
): string[] {
  const reasons: string[] = [];
  if (trials.some((trial) => trial.secretLeaks > 0))
    reasons.push("A trial reported secret leakage.");
  if (trials.some((trial) => trial.policyViolations > 0))
    reasons.push("A trial reported a policy violation.");
  if ((config.evaluation?.requireSchemaCompliance ?? true) && current.schemaComplianceRate < 1) {
    reasons.push("Output schema compliance is below 100%.");
  }
  if (current.acceptanceVerificationRate < 1)
    reasons.push("Required acceptance evidence is incomplete.");
  if (current.taskSuccessRate < 1) reasons.push("At least one evaluation trial failed.");
  if (current.unsupportedClaimRate > 0)
    reasons.push("At least one agent claim has no supporting evidence.");
  if (current.flakyGateRate > 0) reasons.push("At least one deterministic gate is flaky.");
  if (current.behaviorVarianceRate > 0)
    reasons.push("Repeated trials produced inconsistent behavior.");
  if (current.changedFileVarianceRate > 0)
    reasons.push("Repeated trials changed inconsistent file sets.");
  if (current.contextBehaviorVarianceRate > 0)
    reasons.push("Context variants produced inconsistent behavior.");
  if (current.contextChangedFileVarianceRate > 0)
    reasons.push("Context variants changed inconsistent file sets.");
  if (baseline) {
    const allowed = config.evaluation?.maxSuccessRateRegression ?? 0.05;
    if (baseline.metrics.taskSuccessRate - current.taskSuccessRate > allowed) {
      reasons.push(`Task success rate regressed by more than ${allowed * 100} percentage points.`);
    }
    if (current.policyViolationRate > baseline.metrics.policyViolationRate) {
      reasons.push("Policy violation rate regressed from baseline.");
    }
    if (current.behaviorVarianceRate > baseline.metrics.behaviorVarianceRate) {
      reasons.push("Behavioral variance regressed from baseline.");
    }
    if (current.changedFileVarianceRate > (baseline.metrics.changedFileVarianceRate ?? 0)) {
      reasons.push("Changed-file variance regressed from baseline.");
    }
    if (current.contextBehaviorVarianceRate > (baseline.metrics.contextBehaviorVarianceRate ?? 0)) {
      reasons.push("Context behavioral variance regressed from baseline.");
    }
    if (
      current.contextChangedFileVarianceRate >
      (baseline.metrics.contextChangedFileVarianceRate ?? 0)
    ) {
      reasons.push("Context changed-file variance regressed from baseline.");
    }
    if (provenance?.suite !== baseline.suite) {
      reasons.push("Evaluation suite does not match the selected baseline.");
    }
    if (provenance?.configFingerprint !== baseline.configFingerprint) {
      reasons.push("Harness configuration fingerprint changed from baseline.");
    }
    if (provenance?.contextFingerprint !== baseline.contextFingerprint) {
      reasons.push("Evaluation context fingerprint changed from baseline.");
    }
  }
  return reasons;
}

function regressionDrift(
  current: Pick<EvaluationRecord, "agentVersions" | "configFingerprint" | "contextFingerprint">,
  baseline: EvaluationRecord | undefined,
): EvaluationRecord["regression"]["drift"] {
  if (!baseline) return undefined;
  const roles = new Set([
    ...Object.keys(baseline.agentVersions),
    ...Object.keys(current.agentVersions),
  ]);
  const agentVersionChanges = [...roles]
    .sort()
    .filter((role) => baseline.agentVersions[role] !== current.agentVersions[role])
    .map(
      (role) =>
        `${role}: ${baseline.agentVersions[role] ?? "missing"} -> ${current.agentVersions[role] ?? "missing"}`,
    );
  return {
    agentVersionsChanged: agentVersionChanges.length > 0,
    agentVersionChanges,
    configChanged: current.configFingerprint !== baseline.configFingerprint,
    contextChanged: current.contextFingerprint !== baseline.contextFingerprint,
  };
}

function harnessConfigFingerprint(config: SliceForgeConfig): string {
  const harness = Object.fromEntries(Object.entries(config).filter(([key]) => key !== "agents"));
  return fingerprint(harness);
}

function evaluationId(suite: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `${stamp}-${suite.replace(/[^a-zA-Z0-9._-]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

export class EvaluationEngine {
  constructor(
    private readonly projectRoot: string,
    private readonly config: SliceForgeConfig,
    readonly store: RuntimeStore,
  ) {}

  load(id: string): EvaluationRecord {
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) throw new Error(`Invalid evaluation id: ${id}`);
    const filePath = path.join(this.store.paths.evaluations, `${id}.json`);
    if (!fs.existsSync(filePath)) throw new Error(`Evaluation not found: ${id}`);
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as EvaluationRecord;
  }

  baseline(name: string): EvaluationRecord | undefined {
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error(`Invalid baseline name: ${name}`);
    const filePath = path.join(this.store.paths.evaluations, "baselines", `${name}.json`);
    return fs.existsSync(filePath)
      ? (JSON.parse(fs.readFileSync(filePath, "utf8")) as EvaluationRecord)
      : undefined;
  }

  private async agentVersions(): Promise<Record<string, string>> {
    const versions: Record<string, string> = {};
    const configured = [
      ...Object.entries(this.config.agents).map(([name, definition]) => ({ name, definition })),
      ...(this.config.routing?.rules ?? []).map((rule, index) => ({
        name: `routing-${index}-${rule.role}`,
        definition: rule.agent,
      })),
    ];
    for (const { name, definition } of configured) {
      const command =
        definition.type === "codex"
          ? (definition.command ?? "codex")
          : definition.type === "claude"
            ? (definition.command ?? "claude")
            : definition.type === "cursor"
              ? (definition.command ?? "cursor-agent")
              : definition.command!;
      const result = await runProcess(
        { command, args: ["--version"], timeoutMs: 10_000 },
        { root: this.projectRoot, maxOutputBytes: 16_384 },
      );
      const detected =
        result.exitCode === 0
          ? (result.stdout || result.stderr).trim().split(/\r?\n/, 1)[0]
          : "unavailable";
      versions[name] =
        `${definition.type}${definition.model ? `/${definition.model}` : ""}: ${detected}`;
    }
    return versions;
  }

  async run(suitePath: string, baselineName?: string): Promise<EvaluationRecord> {
    const absolute = path.resolve(this.projectRoot, suitePath);
    const relative = path.relative(this.projectRoot, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Evaluation suite escapes project root: ${suitePath}`);
    }
    if (!fs.existsSync(absolute)) throw new Error(`Evaluation suite not found: ${suitePath}`);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Evaluation suite must be a regular non-symlink file: ${suitePath}`);
    }
    if (stat.size > 1024 * 1024) throw new Error("Evaluation suite exceeds 1 MiB.");
    const realProject = fs.realpathSync.native(this.projectRoot);
    const realSuite = fs.realpathSync.native(absolute);
    const realRelative = path.relative(realProject, realSuite);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      throw new Error(`Evaluation suite resolves outside project root: ${suitePath}`);
    }
    let parsed: unknown;
    try {
      parsed = parseStrictJson(fs.readFileSync(absolute, "utf8"));
    } catch (error) {
      throw new Error(
        `Failed to parse evaluation suite: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!evaluationSuiteValidator(parsed)) {
      const details = (evaluationSuiteValidator.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      throw new Error(`Invalid evaluation suite: ${details || "unknown schema error"}`);
    }
    const suite = parsed as EvaluationSuite;
    const caseIds = new Set<string>();
    for (const item of suite.cases) {
      if (caseIds.has(item.id)) throw new Error(`Duplicate evaluation case id: ${item.id}`);
      caseIds.add(item.id);
    }
    const baseline = baselineName ? this.baseline(baselineName) : undefined;
    if (baselineName && !baseline)
      throw new Error(`Evaluation baseline not found: ${baselineName}`);
    const variants = suite.contextVariants?.length
      ? suite.contextVariants
      : (this.config.evaluation?.contextVariants ?? ["original"]);
    const defaultRepetitions = this.config.evaluation?.repetitions ?? 10;
    const trials: EvaluationTrial[] = [];
    for (const item of suite.cases) {
      const repetitions = item.repetitions ?? defaultRepetitions;
      if (repetitions < 1 || repetitions > 100)
        throw new Error(`Invalid repetitions for ${item.id}.`);
      for (const contextVariant of variants) {
        for (let repetition = 0; repetition < repetitions; repetition++) {
          const result = await runProcess(suite.command, {
            root: this.projectRoot,
            stdin: JSON.stringify({
              protocolVersion: "1.0",
              caseId: item.id,
              contextVariant,
              repetition,
              input: item.input,
              context: contextForVariant(item, contextVariant),
            }),
            maxOutputBytes: this.config.reporting.maxLogBytes,
            secrets: [process.env.OPENAI_API_KEY ?? "", process.env.ANTHROPIC_API_KEY ?? ""],
          });
          if (result.exitCode !== 0) {
            trials.push(
              failedTrial(
                item.id,
                contextVariant,
                result.durationMs,
                result.stderr,
                result.sensitiveOutputDetected ? 1 : 0,
              ),
            );
            continue;
          }
          let payload: EvaluationCommandResult;
          try {
            payload = validatePayload(parseStrictJson(result.stdout));
          } catch {
            trials.push(
              failedTrial(
                item.id,
                contextVariant,
                result.durationMs,
                result.stdout,
                result.sensitiveOutputDetected ? 1 : 0,
              ),
            );
            continue;
          }
          let policyViolations: number;
          try {
            policyViolations = validateChangedPaths(
              payload.changedFiles,
              item.allowedPaths ?? (payload.changedFiles.length ? [] : ["**/*"]),
              item.protectedPatterns ?? this.config.policies.protectedPatterns,
            ).length;
          } catch {
            policyViolations = 1;
          }
          const acceptanceVerified = payload.acceptance.filter(
            (entry) => entry.verified && entry.evidence.length > 0,
          ).length;
          const unsupportedClaims = payload.claims.filter(
            (claim) => claim.evidence.length === 0,
          ).length;
          const flakyGates = payload.gates.filter((gate) => gate.status === "flaky").length;
          const secretLeaks = result.sensitiveOutputDetected ? 1 : 0;
          trials.push({
            caseId: item.id,
            contextVariant,
            success:
              acceptanceVerified === payload.acceptance.length &&
              policyViolations === 0 &&
              unsupportedClaims === 0 &&
              flakyGates === 0 &&
              secretLeaks === 0 &&
              !payload.gates.some((gate) => gate.status === "failed"),
            schemaCompliant: true,
            policyViolations,
            unsupportedClaims,
            claimsTotal: payload.claims.length,
            acceptanceVerified,
            acceptanceTotal: payload.acceptance.length,
            retries: payload.retries,
            durationMs: result.durationMs,
            costUSD: payload.costUSD,
            behaviorFingerprint: fingerprint(payload.output),
            changedFilesFingerprint: fingerprint([...payload.changedFiles].sort()),
            flakyGates,
            secretLeaks,
          });
        }
      }
    }
    const metrics = calculateEvaluationMetrics(trials);
    const agentVersions = suite.agentVersions ?? (await this.agentVersions());
    const configFingerprint = harnessConfigFingerprint(this.config);
    const contextFingerprint =
      suite.contextFingerprint ??
      fingerprint({
        name: suite.name,
        command: suite.command,
        cases: suite.cases,
        variants,
      });
    const provenance = {
      suite: suite.name,
      agentVersions,
      configFingerprint,
      contextFingerprint,
    };
    const reasons = regressionReasons(metrics, trials, baseline, this.config, provenance);
    const drift = regressionDrift(provenance, baseline);
    const record: EvaluationRecord = {
      schemaVersion: 1,
      evaluationId: evaluationId(suite.name),
      suite: suite.name,
      createdAt: new Date().toISOString(),
      agentVersions,
      configFingerprint,
      contextFingerprint,
      trials,
      metrics,
      baseline: baselineName,
      regression: {
        passed: reasons.length === 0,
        reasons,
        ...(drift ? { drift } : {}),
      },
    };
    atomicWrite(
      path.join(this.store.paths.evaluations, `${record.evaluationId}.json`),
      JSON.stringify(record, null, 2),
    );
    return record;
  }

  compare(id: string, baselineName = "default"): EvaluationRecord["regression"] {
    const current = this.load(id);
    const baseline = this.baseline(baselineName);
    if (!baseline) throw new Error(`Evaluation baseline not found: ${baselineName}`);
    const reasons = regressionReasons(
      current.metrics,
      current.trials,
      baseline,
      this.config,
      current,
    );
    return {
      passed: reasons.length === 0,
      reasons,
      drift: regressionDrift(current, baseline),
    };
  }

  acceptBaseline(id: string, name = "default"): string {
    const record = this.load(id);
    if (!record.regression.passed)
      throw new Error("A failing evaluation cannot become a baseline.");
    if (!/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error(`Invalid baseline name: ${name}`);
    const filePath = path.join(this.store.paths.evaluations, "baselines", `${name}.json`);
    atomicWrite(filePath, JSON.stringify(record, null, 2));
    return filePath;
  }
}
