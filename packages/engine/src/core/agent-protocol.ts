import type {
  AgentDefinition,
  AgentRequest,
  AgentResponse,
  ClarifierAgentOutput,
  CommandSpec,
  ExecutionAgentRole,
  PlannerAgentOutput,
  PlanningAgentRequest,
  PlanningAgentRole,
  SliceDefinition,
} from "./contracts.js";
import { AGENT_PROTOCOL_VERSION } from "./contracts.js";
import { runProcess, type ProcessRunResult } from "./process-runner.js";
import { createValidator, loadSchema } from "./schema-loader.js";
import { parseTree, type Node as JsonNode } from "jsonc-parser";

const responseSchema = loadSchema("../schemas/agent-response.schema.json");
const responseValidator = createValidator(responseSchema);
const requestValidator = createValidator(loadSchema("../schemas/agent-request.schema.json"), [
  { key: "agent-response.schema.json", schema: responseSchema },
]);

const RESPONSE_KEYS = new Set([
  "protocolVersion",
  "status",
  "summary",
  "artifacts",
  "commandsRun",
  "diagnostics",
  "usage",
  "output",
]);

function assertExactKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw new Error(`${label} has unknown field(s): ${unknown.join(", ")}.`);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateClarifierOutput(value: unknown): ClarifierAgentOutput {
  if (!value || typeof value !== "object")
    throw new Error("Clarifier output must be a JSON object.");
  const output = value as Record<string, unknown>;
  assertExactKeys(
    output,
    ["kind", "readinessScore", "questions", "assumptions", "blockers"],
    "Clarifier output",
  );
  if (output.kind !== "clarification")
    throw new Error("Clarifier output kind must be 'clarification'.");
  if (
    !Number.isInteger(output.readinessScore) ||
    Number(output.readinessScore) < 0 ||
    Number(output.readinessScore) > 100
  ) {
    throw new Error("Clarifier readinessScore must be an integer between 0 and 100.");
  }
  if (!Array.isArray(output.questions) || output.questions.length > 3) {
    throw new Error("Clarifier output may contain at most three questions.");
  }
  const ids = new Set<string>();
  for (const item of output.questions) {
    if (!item || typeof item !== "object")
      throw new Error("Clarifier questions must be JSON objects.");
    const question = item as Record<string, unknown>;
    assertExactKeys(question, ["id", "question", "recommendation"], "Clarifier question");
    if (
      typeof question.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/.test(question.id) ||
      typeof question.question !== "string" ||
      !question.question.trim() ||
      typeof question.recommendation !== "string" ||
      !question.recommendation.trim()
    ) {
      throw new Error("Clarifier question fields are invalid.");
    }
    if (ids.has(question.id)) throw new Error(`Duplicate clarifier question id: ${question.id}.`);
    ids.add(question.id);
  }
  if (!stringArray(output.assumptions) || !stringArray(output.blockers)) {
    throw new Error("Clarifier assumptions and blockers must be arrays of strings.");
  }
  const unknownBlockers = output.blockers.filter((id) => !ids.has(id));
  if (unknownBlockers.length) {
    throw new Error(
      `Clarifier blockers reference unknown questions: ${unknownBlockers.join(", ")}.`,
    );
  }
  if (output.blockers.length !== ids.size) {
    throw new Error("Every clarifier question must be a decision-blocking question.");
  }
  return output as unknown as ClarifierAgentOutput;
}

function validatePlannerOutput(value: unknown): PlannerAgentOutput {
  if (!value || typeof value !== "object") throw new Error("Planner output must be a JSON object.");
  const output = value as Record<string, unknown>;
  assertExactKeys(
    output,
    ["kind", "slices", "assumptions", "risks", "estimatedCostUSD"],
    "Planner output",
  );
  if (output.kind !== "plan") throw new Error("Planner output kind must be 'plan'.");
  if (
    !Array.isArray(output.slices) ||
    output.slices.length === 0 ||
    !output.slices.every((slice) => slice && typeof slice === "object" && !Array.isArray(slice))
  ) {
    throw new Error("Planner output slices must be a non-empty array of objects.");
  }
  if (!stringArray(output.assumptions) || !stringArray(output.risks)) {
    throw new Error("Planner assumptions and risks must be arrays of strings.");
  }
  if (
    output.estimatedCostUSD !== undefined &&
    (!Number.isFinite(output.estimatedCostUSD) || Number(output.estimatedCostUSD) < 0)
  ) {
    throw new Error("Planner estimatedCostUSD must be a non-negative number.");
  }
  return output as unknown as PlannerAgentOutput;
}

function rejectDuplicateKeys(node: JsonNode | undefined, location = "$"): void {
  if (!node) throw new Error("Agent response is not valid JSON.");
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = String(property.children?.[0]?.value ?? "");
      if (keys.has(key))
        throw new Error(`Agent response contains duplicate key '${key}' at ${location}.`);
      keys.add(key);
      rejectDuplicateKeys(property.children?.[1], `${location}.${key}`);
    }
  } else if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries())
      rejectDuplicateKeys(child, `${location}[${index}]`);
  }
}

export function parseStrictJson(raw: string): unknown {
  const errors: Array<{ error: number; offset: number; length: number }> = [];
  const tree = parseTree(raw, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length)
    throw new Error("Agent response is not one complete valid JSON document.");
  rejectDuplicateKeys(tree);
  return JSON.parse(raw) as unknown;
}

const AGENT_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMP",
  "TEMP",
  "TMPDIR",
];

function builtInCommand(agent: AgentDefinition, request: AgentRequest): CommandSpec {
  if (agent.type === "command") {
    return {
      command: agent.command!,
      args: agent.args ?? [],
      timeoutMs: agent.timeoutMs ?? 10 * 60 * 1000,
      envAllowlist: AGENT_ENV,
    };
  }
  if (agent.type === "codex") {
    return {
      command: agent.command ?? "codex",
      args:
        agent.args ??
        (request.constraints.readOnly
          ? [
              "exec",
              ...(agent.model ? ["--model", agent.model] : []),
              "--sandbox",
              "read-only",
              "-",
            ]
          : ["exec", ...(agent.model ? ["--model", agent.model] : []), "--full-auto", "-"]),
      timeoutMs: agent.timeoutMs ?? 10 * 60 * 1000,
      envAllowlist: [...AGENT_ENV, "OPENAI_API_KEY"],
    };
  }
  if (agent.type === "claude") {
    return {
      command: agent.command ?? "claude",
      args:
        agent.args ??
        (request.constraints.readOnly
          ? [
              "-p",
              ...(agent.model ? ["--model", agent.model] : []),
              "--output-format",
              "json",
              "--permission-mode",
              "plan",
            ]
          : ["-p", ...(agent.model ? ["--model", agent.model] : []), "--output-format", "json"]),
      timeoutMs: agent.timeoutMs ?? 10 * 60 * 1000,
      envAllowlist: [...AGENT_ENV, "ANTHROPIC_API_KEY"],
    };
  }
  return {
    command: agent.command ?? "cursor-agent",
    args:
      agent.args ??
      (request.constraints.readOnly
        ? ["-p", ...(agent.model ? ["--model", agent.model] : [])]
        : ["-p", ...(agent.model ? ["--model", agent.model] : []), "--force"]),
    timeoutMs: agent.timeoutMs ?? 10 * 60 * 1000,
    envAllowlist: AGENT_ENV,
  };
}

function validateResponse(value: unknown, role: AgentRequest["role"]): AgentResponse {
  if (!value || typeof value !== "object") throw new Error("Agent response must be a JSON object.");
  if (!responseValidator(value)) {
    const details = (responseValidator.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Agent response schema validation failed: ${details}`);
  }
  const response = value as Partial<AgentResponse>;
  const unknownKeys = Object.keys(response).filter((key) => !RESPONSE_KEYS.has(key));
  if (unknownKeys.length)
    throw new Error(`Agent response has unknown field(s): ${unknownKeys.join(", ")}.`);
  if (response.protocolVersion !== AGENT_PROTOCOL_VERSION) {
    throw new Error(`Agent protocol mismatch. Expected ${AGENT_PROTOCOL_VERSION}.`);
  }
  if (!response.status || !["completed", "failed", "blocked"].includes(response.status)) {
    throw new Error("Agent response has an invalid status.");
  }
  if (typeof response.summary !== "string") throw new Error("Agent response summary is required.");
  if (
    !Array.isArray(response.artifacts) ||
    !response.artifacts.every((item) => typeof item === "string")
  ) {
    throw new Error("Agent response artifacts must be an array of strings.");
  }
  if (
    !Array.isArray(response.commandsRun) ||
    !response.commandsRun.every((item) => typeof item === "string")
  ) {
    throw new Error("Agent response commandsRun must be an array of strings.");
  }
  if (
    !Array.isArray(response.diagnostics) ||
    !response.diagnostics.every((item) => {
      if (!item || typeof item !== "object") return false;
      const diagnostic = item as Record<string, unknown>;
      return (
        Object.keys(diagnostic).every((key) => ["severity", "message", "file"].includes(key)) &&
        ["info", "warning", "error"].includes(String(diagnostic.severity)) &&
        typeof diagnostic.message === "string" &&
        (diagnostic.file === undefined || typeof diagnostic.file === "string")
      );
    })
  )
    throw new Error("Agent response diagnostics are invalid.");
  if (response.usage !== undefined) {
    if (
      !response.usage ||
      typeof response.usage !== "object" ||
      !Number.isFinite(response.usage.inputTokens) ||
      response.usage.inputTokens! < 0 ||
      !Number.isFinite(response.usage.outputTokens) ||
      response.usage.outputTokens! < 0 ||
      (response.usage.estimatedCostUSD !== undefined &&
        (!Number.isFinite(response.usage.estimatedCostUSD) || response.usage.estimatedCostUSD < 0))
    ) {
      throw new Error("Agent response usage is invalid.");
    }
  }
  if (role === "clarifier") response.output = validateClarifierOutput(response.output);
  else if (role === "planner") response.output = validatePlannerOutput(response.output);
  else if (response.output !== undefined)
    throw new Error(`Execution agent '${role}' must not return planning output.`);
  return response as AgentResponse;
}

function findProtocolPayload(value: unknown): unknown {
  if (typeof value === "string") {
    const marker = "SLICEFORGE_RESPONSE_JSON=";
    const index = value.lastIndexOf(marker);
    if (index >= 0) {
      const raw = value
        .slice(index + marker.length)
        .trim()
        .split(/\r?\n/, 1)[0];
      try {
        return parseStrictJson(raw);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index--) {
      const found = findProtocolPayload(value[index]);
      if (found !== undefined) return found;
    }
  } else if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const found = findProtocolPayload(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function parseBuiltInOutput(result: ProcessRunResult, role: AgentRequest["role"]): AgentResponse {
  const markerCount = [result.stdout, result.stderr].reduce(
    (count, value) => count + (value.match(/SLICEFORGE_RESPONSE_JSON=/g)?.length ?? 0),
    0,
  );
  if (markerCount > 1) throw new Error("Agent emitted more than one SliceForge protocol response.");
  const candidates = [result.stdout, result.stderr];
  for (const candidate of candidates) {
    const direct = candidate.trim();
    if (direct) {
      try {
        const parsed = parseStrictJson(direct);
        try {
          return validateResponse(parsed, role);
        } catch {
          const nested = findProtocolPayload(parsed);
          if (nested !== undefined) return validateResponse(nested, role);
        }
      } catch {
        const nested = findProtocolPayload(candidate);
        if (nested !== undefined) return validateResponse(nested, role);
      }
    }
    for (const line of candidate.split(/\r?\n/).reverse()) {
      try {
        const parsed = parseStrictJson(line);
        const nested = findProtocolPayload(parsed);
        if (nested !== undefined) return validateResponse(nested, role);
      } catch {
        // Continue searching event-stream lines.
      }
    }
  }
  throw new Error("Agent did not emit a valid SliceForge protocol response.");
}

function renderPrompt(request: AgentRequest): string {
  const responseExample: AgentResponse = {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    status: "completed",
    summary: "Brief factual summary",
    artifacts: [],
    commandsRun: [],
    diagnostics: [],
  };
  if (request.role === "clarifier" || request.role === "planner") {
    responseExample.output = request.context.proposal;
  }
  const taskPrompt =
    "task" in request
      ? [
          `Task request:\n${JSON.stringify(request.task, null, 2)}`,
          request.packet ? `Current task packet:\n${JSON.stringify(request.packet, null, 2)}` : "",
          `Repository context and deterministic proposal:\n${JSON.stringify(request.context, null, 2)}`,
          request.role === "clarifier"
            ? "Return at most three decision-blocking questions. Preserve useful stable question IDs from the proposal. Do not invent source facts."
            : "Return a dependency graph only for the allowed targets. Every acceptance criterion must have required evidence tied to an executable gate, artifact, visual check or manual approval. Split slices only when they can be verified independently.",
        ]
      : [
          `Slice specification:\n${JSON.stringify(request.slice, null, 2)}`,
          request.context.diff ? `Sanitized diff to review:\n${request.context.diff}` : "",
          request.context.priorFailures.length
            ? `Prior failures to address:\n${request.context.priorFailures.join("\n")}`
            : "",
        ];
  return [
    `You are the SliceForge ${request.role} agent.`,
    request.constraints.readOnly
      ? "This task is read-only. Do not modify any file or Git state."
      : `You may modify only these paths: ${request.constraints.allowedPaths.join(", ")}.`,
    `Work in: ${request.cwd}`,
    ...taskPrompt,
    "Do the requested work and verify it. Your final message must end with exactly one line:",
    `SLICEFORGE_RESPONSE_JSON=${JSON.stringify(responseExample)}`,
    "Replace the JSON values with truthful results. Do not wrap that final line in Markdown.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export class AgentProtocolRunner {
  async run(
    definition: AgentDefinition,
    request: AgentRequest,
    maxOutputBytes: number,
    cancellationFile?: string,
  ): Promise<AgentResponse> {
    if (!requestValidator(request)) {
      const details = (requestValidator.errors ?? [])
        .map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("; ");
      throw new Error(`Agent request schema validation failed: ${details}`);
    }
    if (definition.type === "command" && !definition.capabilities?.includes(request.role)) {
      throw new Error(`Generic agent does not declare the '${request.role}' capability.`);
    }
    const command = builtInCommand(definition, request);
    const runtimeEnvironment = "slice" in request ? request.constraints.environment : undefined;
    const input = definition.type === "command" ? JSON.stringify(request) : renderPrompt(request);
    const result = await runProcess(command, {
      root: request.cwd,
      stdin: input,
      maxOutputBytes,
      secrets: [process.env.OPENAI_API_KEY ?? "", process.env.ANTHROPIC_API_KEY ?? ""],
      cancellationFile,
      environment: runtimeEnvironment,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Agent ${request.role} failed with exit ${result.exitCode}${result.timedOut ? " (timeout)" : ""}${result.cancelled ? " (cancelled)" : ""}: ${result.stderr}`,
      );
    }
    return definition.type === "command"
      ? validateResponse(parseStrictJson(result.stdout), request.role)
      : parseBuiltInOutput(result, request.role);
  }
}

export function createAgentRequest(
  runId: string,
  role: ExecutionAgentRole,
  cwd: string,
  slice: SliceDefinition,
  options: {
    readOnly: boolean;
    allowedPaths: string[];
    artifacts: string[];
    priorFailures: string[];
    diff?: string;
    environment?: Record<string, string>;
  },
): AgentRequest {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    runId,
    role,
    cwd,
    slice,
    constraints: {
      readOnly: options.readOnly,
      allowedPaths: options.allowedPaths,
      requiredArtifacts: options.artifacts,
      environment: options.environment,
    },
    context: { priorFailures: options.priorFailures, diff: options.diff },
  };
}

export function createPlanningAgentRequest(
  runId: string,
  role: PlanningAgentRole,
  cwd: string,
  request: Omit<PlanningAgentRequest, "protocolVersion" | "runId" | "role" | "cwd">,
): PlanningAgentRequest {
  return {
    protocolVersion: AGENT_PROTOCOL_VERSION,
    runId,
    role,
    cwd,
    ...request,
  };
}
