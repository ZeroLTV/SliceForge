export const SCHEMA_VERSION = 1 as const;
export const AGENT_PROTOCOL_VERSION = "1.0" as const;

export enum ExitCode {
  Success = 0,
  GateFailed = 1,
  ConfigurationError = 2,
  Blocked = 3,
  InternalError = 4,
}

export type AgentRole = "clarifier" | "planner" | "implementer" | "testgen" | "reviewer";
export type PlanningAgentRole = Extract<AgentRole, "clarifier" | "planner">;
export type ExecutionAgentRole = "implementer" | "testgen" | "reviewer";
export type AgentType = "codex" | "claude" | "cursor" | "command";
export type TargetPreset = "node" | "dotnet" | "python" | "java" | "react-native" | "generic";
export type GateKind =
  "artifact" | "build" | "lint" | "unit" | "integration" | "e2e" | "browser" | "review";
export type GateStatus = "passed" | "failed" | "warning" | "skipped";
export type RunStatus =
  | "planned"
  | "preparing"
  | "implementing"
  | "validating"
  | "reviewing"
  | "needs_attention"
  | "ready_to_promote"
  | "promoting"
  | "promoted"
  | "failed"
  | "blocked"
  | "cancelled";

export interface CommandSpec {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
  envAllowlist?: string[];
  shell?: boolean;
}

export interface AgentDefinition {
  type: AgentType;
  command?: string;
  args?: string[];
  model?: string;
  timeoutMs?: number;
  capabilities?: AgentRole[];
}

export interface AgentRoutingRule {
  role: AgentRole;
  targets?: string[];
  presets?: TargetPreset[];
  minComplexity?: number;
  maxComplexity?: number;
  agent: AgentDefinition;
}

export interface TargetDefinition {
  root: string;
  preset: TargetPreset;
  dependsOn?: string[];
  prepare?: CommandSpec;
  commands: Partial<Record<Exclude<GateKind, "artifact" | "review">, CommandSpec>>;
  health?: { url: string; timeoutMs?: number };
}

export interface VisualViewportDefinition {
  id: string;
  width: number;
  height: number;
}

export interface BrowserVisualConfig {
  artifactDirectory: string;
  manifestPath: string;
  baselineDirectory?: string;
  requiredViewports: VisualViewportDefinition[];
  maxDiffRatio: number;
  pixelThreshold: number;
  maxScreenshotBytes: number;
  requireNoRuntimeErrors: boolean;
  requireNoOverflow: boolean;
  requireAccessibility: boolean;
  requireAssets: boolean;
}

export interface SliceForgeConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  project: string;
  agents: Record<ExecutionAgentRole, AgentDefinition> &
    Partial<Record<Extract<AgentRole, "clarifier" | "planner">, AgentDefinition>>;
  targets: Record<string, TargetDefinition>;
  isolation: { mode: "worktree" };
  gates: {
    order: GateKind[];
    browser: {
      enabled: boolean;
      command?: CommandSpec;
      reportPath?: string;
      visual?: BrowserVisualConfig;
    };
    review: { enabled: boolean; advisory: boolean };
  };
  policies: {
    protectedPatterns: string[];
    maxRetries: number;
  };
  routing?: {
    fallbackRole: ExecutionAgentRole;
    maxEstimatedCostUSD?: number;
    minimumReadinessScore?: number;
    rules?: AgentRoutingRule[];
  };
  execution?: {
    concurrency: number;
    taskTimeoutMs: number;
    maxRepairAttempts: number;
    maxRepeatedFailure: number;
    leaseMs: number;
    portRange?: { start: number; end: number };
    portEnv?: string[];
  };
  evaluation?: {
    repetitions: number;
    contextVariants: ContextVariant[];
    maxSuccessRateRegression: number;
    requireSchemaCompliance: boolean;
  };
  inputs?: {
    maxAttachmentBytes: number;
    figmaProvider?: CommandSpec;
  };
  documentation?: {
    defaultImpact: DocsImpact;
    requireReviewWhenUncertain: boolean;
  };
  reporting: {
    directory?: string;
    retainRuns: number;
    maxLogBytes: number;
  };
  ci: { reportOnly: true };
}

export interface AcceptanceCriterion {
  id: string;
  given?: string;
  when?: string;
  then?: string;
  expected?: string;
}

export interface SliceDefinition {
  id: string;
  title: string;
  description?: string;
  priority: number;
  dependsOn?: string[];
  targets: string[];
  acceptance: AcceptanceCriterion[];
  allowedPaths: string[];
  requiredArtifacts?: string[];
  requiredGates?: GateKind[];
  docs?: string[];
  docsImpact?: DocsImpact;
  evidence?: EvidenceRequirement[];
  retryPolicy?: { maxAttempts: number };
}

export interface SliceForgePlan {
  schemaVersion: typeof SCHEMA_VERSION;
  slices: SliceDefinition[];
}

export interface ExecutionAgentRequest {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  runId: string;
  role: ExecutionAgentRole;
  cwd: string;
  slice: SliceDefinition;
  constraints: {
    readOnly: boolean;
    allowedPaths: string[];
    requiredArtifacts: string[];
    environment?: Record<string, string>;
  };
  context: { priorFailures: string[]; diff?: string };
}

export interface PlanningAgentRequest {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  runId: string;
  role: PlanningAgentRole;
  cwd: string;
  task: TaskRequest;
  packet?: TaskPacket;
  constraints: {
    readOnly: true;
    maxQuestions: 3;
    allowedTargets: string[];
    targetRoots: Record<string, string>;
  };
  context: {
    project: string;
    documentation: string[];
    repositoryContext: RepositoryContextEntry[];
    targetGates: Record<string, GateKind[]>;
    proposal: ClarifierAgentOutput | PlannerAgentOutput;
  };
}

export type AgentRequest = ExecutionAgentRequest | PlanningAgentRequest;

export interface ClarifierAgentOutput {
  kind: "clarification";
  readinessScore: number;
  questions: Array<Pick<ClarificationQuestion, "id" | "question" | "recommendation">>;
  assumptions: string[];
  blockers: string[];
}

export interface PlannerAgentOutput {
  kind: "plan";
  slices: SliceDefinition[];
  assumptions: string[];
  risks: string[];
  estimatedCostUSD?: number;
}

export type PlanningAgentOutput = ClarifierAgentOutput | PlannerAgentOutput;

export interface AgentResponse {
  protocolVersion: typeof AGENT_PROTOCOL_VERSION;
  status: "completed" | "failed" | "blocked";
  summary: string;
  artifacts: string[];
  commandsRun: string[];
  diagnostics: Array<{ severity: "info" | "warning" | "error"; message: string; file?: string }>;
  usage?: { inputTokens: number; outputTokens: number; estimatedCostUSD?: number };
  output?: PlanningAgentOutput;
}

export interface GateResult {
  id: string;
  kind: GateKind;
  status: GateStatus;
  startedAt: string;
  durationMs: number;
  summary: string;
  command?: CommandSpec;
  stdout?: string;
  stderr?: string;
  artifacts: string[];
}

export interface VisualViewportResult {
  id: string;
  width: number;
  height: number;
  screenshot: string;
  runtimeErrors: string[];
  overflow: string[];
  accessibilityViolations: Array<{
    id: string;
    impact: "minor" | "moderate" | "serious" | "critical";
    description: string;
  }>;
  missingAssets: string[];
}

export interface VisualManifest {
  schemaVersion: 1;
  viewports: VisualViewportResult[];
}

export interface RunEvent {
  sequence: number;
  timestamp: string;
  status: RunStatus;
  message: string;
  data?: Record<string, unknown>;
}

export interface RunRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  kind: "implementation" | "testgen" | "task";
  projectRoot: string;
  sliceId: string;
  status: RunStatus;
  baseBranch: string;
  baseSha: string;
  branchName: string;
  worktreePath: string;
  attempt: number;
  createdAt: string;
  updatedAt: string;
  sequence: number;
  commitSha?: string;
  promotedSha?: string;
  finalFingerprint?: string;
  priorFailures: string[];
  failureHistory?: FailurePacket[];
  gates: GateResult[];
  agentResponses: Partial<Record<AgentRole, AgentResponse>>;
  changedFiles?: string[];
  sanitizedDiff?: string;
  acceptanceCoverage?: Array<{
    id: string;
    status: EvidenceStatus;
    evidence: string[];
  }>;
  policyViolations?: string[];
  bundleSlices?: SliceDefinition[];
  runtimeEnv?: Record<string, string>;
}

export type TaskStatus =
  | "draft"
  | "clarifying"
  | "ready_to_plan"
  | "planning"
  | "awaiting_approval"
  | "queued"
  | "running"
  | "needs_attention"
  | "ready_to_promote"
  | "promoting"
  | "promoted"
  | "failed"
  | "blocked"
  | "cancelled";

export type DocsImpact = "none" | "required" | "review";
export type EvidenceKind = "test" | "command" | "artifact" | "visual" | "manual";
export type EvidenceStatus = "verified" | "manual_required" | "unverified";
export type ContextVariant = "original" | "reordered" | "irrelevant" | "reduced";

export interface TaskAttachment {
  id: string;
  kind: "document" | "image" | "figma";
  source: string;
  storedPath?: string;
  sha256?: string;
  sizeBytes?: number;
}

export interface TaskRequest {
  id: string;
  request: string;
  targets: string[];
  constraints: string[];
  priority: number;
  attachments: TaskAttachment[];
  createdAt: string;
}

export interface RepositoryContextEntry {
  path: string;
  kind: "convention" | "manifest" | "api-schema" | "documentation";
  sha256: string;
  sizeBytes: number;
  snippet: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  recommendation: string;
  answer?: string;
}

export interface TaskPacket {
  request: TaskRequest;
  contextFingerprint: string;
  contextSummary: {
    project: string;
    targets: string[];
    targetRoots: Record<string, string>;
    documentation: string[];
    files: RepositoryContextEntry[];
  };
  readinessScore: number;
  assumptions: string[];
  decisions: Array<{ questionId: string; answer: string }>;
  blockers: string[];
  questions: ClarificationQuestion[];
}

export interface EvidenceRequirement {
  acceptanceId: string;
  kind: EvidenceKind;
  source?: string;
  required?: boolean;
}

export interface EvidenceRecord extends EvidenceRequirement {
  id: string;
  status: EvidenceStatus;
  fingerprint: string;
  recordedAt: string;
  details: string;
}

export interface SliceGraph {
  taskId: string;
  revision: number;
  slices: SliceDefinition[];
  evidence: EvidenceRequirement[];
  assumptions: string[];
  risks: string[];
  estimatedCostUSD?: number;
  fingerprint: string;
}

export interface QueueLease {
  workerId: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
}

export interface QueueItem {
  taskId: string;
  priority: number;
  dependencies: string[];
  attempts: number;
  maxAttempts: number;
  budget?: { maxDurationMs: number; maxCostUSD?: number };
  resources?: { targetLocks: string[]; network: boolean };
  lease?: QueueLease;
  enqueuedAt: string;
}

export interface FailurePacket {
  fingerprint: string;
  category: "gate" | "policy" | "agent" | "environment" | "internal";
  owner: AgentRole | "engine";
  summary: string;
  gateIds: string[];
  attempt: number;
  occurredAt: string;
}

export interface TaskRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  taskId: string;
  projectRoot: string;
  status: TaskStatus;
  request: TaskRequest;
  packet: TaskPacket;
  graph?: SliceGraph;
  queue?: QueueItem;
  runIds: string[];
  supersededRunIds?: string[];
  evidence: EvidenceRecord[];
  planningAgentResponses?: Partial<Record<PlanningAgentRole, AgentResponse>>;
  revision: number;
  approvedFingerprint?: string;
  execution?: {
    baseBranch: string;
    baseSha: string;
    stagingBranch: string;
    stagingWorktreePath: string;
    integratedSliceIds: string[];
    pendingRunId?: string;
    bundleRunId?: string;
  };
  createdAt: string;
  updatedAt: string;
  sequence: number;
  lastError?: string;
}

export interface TaskEvent {
  sequence: number;
  timestamp: string;
  status: TaskStatus;
  message: string;
  data?: Record<string, unknown>;
}

export interface EvaluationTrial {
  caseId: string;
  contextVariant: ContextVariant;
  success: boolean;
  schemaCompliant: boolean;
  policyViolations: number;
  unsupportedClaims: number;
  claimsTotal: number;
  acceptanceVerified: number;
  acceptanceTotal: number;
  retries: number;
  durationMs: number;
  costUSD: number;
  behaviorFingerprint: string;
  changedFilesFingerprint: string;
  flakyGates: number;
  secretLeaks: number;
}

export interface EvaluationMetrics {
  taskSuccessRate: number;
  acceptanceVerificationRate: number;
  schemaComplianceRate: number;
  policyViolationRate: number;
  unsupportedClaimRate: number;
  flakyGateRate: number;
  behaviorVarianceRate: number;
  changedFileVarianceRate: number;
  contextBehaviorVarianceRate: number;
  contextChangedFileVarianceRate: number;
  averageRetries: number;
  averageDurationMs: number;
  totalCostUSD: number;
}

export interface EvaluationRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  evaluationId: string;
  suite: string;
  createdAt: string;
  agentVersions: Record<string, string>;
  configFingerprint: string;
  contextFingerprint: string;
  trials: EvaluationTrial[];
  metrics: EvaluationMetrics;
  baseline?: string;
  regression: {
    passed: boolean;
    reasons: string[];
    drift?: {
      agentVersionsChanged: boolean;
      agentVersionChanges: string[];
      configChanged: boolean;
      contextChanged: boolean;
    };
  };
}

export interface DoctorCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  message: string;
  remediation?: string;
}

export interface DoctorReport {
  projectRoot: string;
  checks: DoctorCheck[];
  ok: boolean;
}
