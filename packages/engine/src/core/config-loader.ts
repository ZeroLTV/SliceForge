import * as fs from "fs";
import * as path from "path";
import {
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import { createValidator, loadSchema } from "./schema-loader.js";
import type { SliceDefinition, SliceForgeConfig, SliceForgePlan } from "./contracts.js";

const configValidator = createValidator(loadSchema("../schemas/config.schema.json"));
const planValidator = createValidator(loadSchema("../schemas/plan.schema.json"));

function rejectDuplicateConfigKeys(node: JsonNode | undefined, location = "$"): void {
  if (!node) return;
  if (node.type === "object") {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = String(property.children?.[0]?.value ?? "");
      if (keys.has(key)) throw new Error(`Duplicate configuration key '${key}' at ${location}.`);
      keys.add(key);
      rejectDuplicateConfigKeys(property.children?.[1], `${location}.${key}`);
    }
  } else if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries()) {
      rejectDuplicateConfigKeys(child, `${location}[${index}]`);
    }
  }
}

function validationMessage(
  type: "configuration" | "plan",
  errors: typeof configValidator.errors,
): string {
  const details = (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
  return `Invalid SliceForge ${type}: ${details || "unknown validation error"}`;
}

function assertInsideProject(projectRoot: string, configuredPath: string, label: string): void {
  if (configuredPath.includes("\0")) throw new Error(`${label} contains a NUL byte.`);
  const absolutePath = path.resolve(projectRoot, configuredPath);
  const relative = path.relative(projectRoot, absolutePath);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes the project root: ${configuredPath}`);
  }
}

function assertSafeRuntimePath(configuredPath: string, label: string): void {
  if (
    !configuredPath ||
    configuredPath.includes("\0") ||
    path.isAbsolute(configuredPath) ||
    configuredPath === ".." ||
    configuredPath.replace(/\\/g, "/").startsWith("../")
  ) {
    throw new Error(`${label} must be a safe runtime-relative path: ${configuredPath}`);
  }
}

export function loadConfig(projectRoot: string): SliceForgeConfig {
  const configPath = path.join(projectRoot, "sliceforge.config.jsonc");
  if (!fs.existsSync(configPath)) {
    throw new Error(`SliceForge configuration not found: ${configPath}. Run 'sliceforge init'.`);
  }
  const content = fs.readFileSync(configPath, "utf8");
  const parseErrors: ParseError[] = [];
  const value = parseJsonc(content, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  }) as unknown;
  if (parseErrors.length > 0) {
    const details = parseErrors
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join("; ");
    throw new Error(`Failed to parse ${configPath}: ${details}`);
  }
  rejectDuplicateConfigKeys(
    parseTree(content, [], { allowTrailingComma: true, disallowComments: false }),
  );
  return validateConfig(value, projectRoot);
}

export function validateConfig(value: unknown, projectRoot: string): SliceForgeConfig {
  if (!configValidator(value))
    throw new Error(validationMessage("configuration", configValidator.errors));
  const config = value as SliceForgeConfig;
  if (
    config.execution?.portRange &&
    config.execution.portRange.end < config.execution.portRange.start
  ) {
    throw new Error("execution.portRange.end must be greater than or equal to start.");
  }
  if (
    config.execution?.portRange &&
    config.execution.portRange.end - config.execution.portRange.start + 1 > 10_000
  ) {
    throw new Error("execution.portRange may contain at most 10000 ports.");
  }
  if (config.reporting.directory) {
    assertSafeRuntimePath(config.reporting.directory, "reporting.directory");
  }
  if (config.gates.browser.reportPath) {
    assertInsideProject(projectRoot, config.gates.browser.reportPath, "gates.browser.reportPath");
  }
  const visual = config.gates.browser.visual;
  if (visual) {
    if (!config.gates.browser.enabled) {
      throw new Error("gates.browser.visual requires gates.browser.enabled=true.");
    }
    assertInsideProject(
      projectRoot,
      visual.artifactDirectory,
      "gates.browser.visual.artifactDirectory",
    );
    assertInsideProject(projectRoot, visual.manifestPath, "gates.browser.visual.manifestPath");
    if (visual.baselineDirectory) {
      assertInsideProject(
        projectRoot,
        visual.baselineDirectory,
        "gates.browser.visual.baselineDirectory",
      );
    }
    const artifactRoot = path.resolve(projectRoot, visual.artifactDirectory);
    const manifest = path.resolve(projectRoot, visual.manifestPath);
    const manifestRelative = path.relative(artifactRoot, manifest);
    if (
      manifestRelative === ".." ||
      manifestRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(manifestRelative)
    ) {
      throw new Error("gates.browser.visual.manifestPath must be inside artifactDirectory.");
    }
    assertUnique(
      visual.requiredViewports.map((viewport) => viewport.id),
      "visual viewport id",
    );
  }
  if (config.inputs?.figmaProvider?.cwd) {
    assertInsideProject(projectRoot, config.inputs.figmaProvider.cwd, "inputs.figmaProvider.cwd");
  }
  for (const [targetName, target] of Object.entries(config.targets)) {
    assertInsideProject(projectRoot, target.root, `Target '${targetName}' root`);
    if (target.prepare?.cwd)
      assertInsideProject(
        path.resolve(projectRoot, target.root),
        target.prepare.cwd,
        `${targetName}.prepare.cwd`,
      );
    for (const [gate, command] of Object.entries(target.commands)) {
      if (command?.cwd)
        assertInsideProject(
          path.resolve(projectRoot, target.root),
          command.cwd,
          `${targetName}.${gate}.cwd`,
        );
    }
    for (const dependency of target.dependsOn ?? []) {
      if (!config.targets[dependency]) {
        throw new Error(`Target '${targetName}' depends on unknown target '${dependency}'.`);
      }
    }
  }
  for (const [index, rule] of (config.routing?.rules ?? []).entries()) {
    if (
      rule.minComplexity !== undefined &&
      rule.maxComplexity !== undefined &&
      rule.minComplexity > rule.maxComplexity
    ) {
      throw new Error(`routing.rules[${index}].minComplexity must not exceed maxComplexity.`);
    }
    for (const target of rule.targets ?? []) {
      if (!config.targets[target]) {
        throw new Error(`routing.rules[${index}] references unknown target '${target}'.`);
      }
    }
    if (rule.agent.capabilities && !rule.agent.capabilities.includes(rule.role)) {
      throw new Error(
        `routing.rules[${index}] agent does not declare required '${rule.role}' capability.`,
      );
    }
  }
  assertTargetGraph(config);
  return config;
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${label}: ${value}`);
    seen.add(value);
  }
}

function assertAcyclic(slices: SliceDefinition[]): void {
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Slice dependency cycle detected at '${id}'.`);
    if (visited.has(id)) return;
    const slice = byId.get(id);
    if (!slice) throw new Error(`Unknown slice dependency '${id}'.`);
    visiting.add(id);
    for (const dependency of slice.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const slice of slices) visit(slice.id);
}

function assertTargetGraph(config: SliceForgeConfig): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) throw new Error(`Target dependency cycle detected at '${name}'.`);
    if (visited.has(name)) return;
    const target = config.targets[name];
    if (!target) throw new Error(`Unknown target dependency '${name}'.`);
    visiting.add(name);
    for (const dependency of target.dependsOn ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of Object.keys(config.targets)) visit(name);
}

export function loadPlan(projectRoot: string, config: SliceForgeConfig): SliceForgePlan {
  const planPath = path.join(projectRoot, "sliceforge.plan.yaml");
  if (!fs.existsSync(planPath)) {
    throw new Error(`SliceForge plan not found: ${planPath}. Run 'sliceforge init'.`);
  }
  let value: unknown;
  try {
    value = parseYaml(fs.readFileSync(planPath, "utf8"));
  } catch (err) {
    throw new Error(
      `Failed to parse ${planPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return validatePlan(value, config, projectRoot);
}

export function validatePlan(
  value: unknown,
  config: SliceForgeConfig,
  projectRoot: string,
): SliceForgePlan {
  if (!planValidator(value)) throw new Error(validationMessage("plan", planValidator.errors));
  const plan = value as SliceForgePlan;
  assertUnique(
    plan.slices.map((slice) => slice.id),
    "slice id",
  );
  assertUnique(
    plan.slices.flatMap((slice) => slice.acceptance.map((criterion) => criterion.id)),
    "acceptance id",
  );
  assertAcyclic(plan.slices);
  for (const slice of plan.slices) {
    const acceptanceIds = new Set(slice.acceptance.map((criterion) => criterion.id));
    const evidenceKeys = new Set<string>();
    const requiredEvidenceByAcceptance = new Map<string, number>();
    for (const requirement of slice.evidence ?? []) {
      if (!acceptanceIds.has(requirement.acceptanceId)) {
        throw new Error(
          `Slice '${slice.id}' evidence references unknown acceptance '${requirement.acceptanceId}'.`,
        );
      }
      const key = `${requirement.acceptanceId}:${requirement.kind}:${requirement.source ?? ""}`;
      if (evidenceKeys.has(key))
        throw new Error(`Slice '${slice.id}' has duplicate evidence '${key}'.`);
      evidenceKeys.add(key);
      if (requirement.required !== false) {
        requiredEvidenceByAcceptance.set(
          requirement.acceptanceId,
          (requiredEvidenceByAcceptance.get(requirement.acceptanceId) ?? 0) + 1,
        );
      }
    }
    if (slice.acceptance.length > 1 && !(slice.evidence ?? []).length) {
      throw new Error(
        `Slice '${slice.id}' has multiple acceptance criteria but no explicit evidence mapping.`,
      );
    }
    if ((slice.evidence ?? []).length) {
      for (const acceptanceId of acceptanceIds) {
        if (!requiredEvidenceByAcceptance.has(acceptanceId)) {
          throw new Error(
            `Slice '${slice.id}' acceptance '${acceptanceId}' has no required evidence.`,
          );
        }
      }
    }
    for (const target of slice.targets) {
      if (!config.targets[target])
        throw new Error(`Slice '${slice.id}' references unknown target '${target}'.`);
    }
    for (const configuredPath of [
      ...slice.allowedPaths,
      ...(slice.requiredArtifacts ?? []),
      ...(slice.docs ?? []),
    ]) {
      assertInsideProject(projectRoot, configuredPath, `Slice '${slice.id}' path`);
    }
    const enabled = new Set(slice.requiredGates ?? config.gates.order);
    const targetNames = new Set<string>();
    const addTarget = (name: string): void => {
      if (targetNames.has(name)) return;
      for (const dependency of config.targets[name].dependsOn ?? []) addTarget(dependency);
      targetNames.add(name);
    };
    for (const name of slice.targets) addTarget(name);
    const commandEvidenceKinds = ["build", "lint", "unit", "integration", "e2e"] as const;
    const hasCommandEvidence = commandEvidenceKinds.some(
      (kind) =>
        enabled.has(kind) &&
        [...targetNames].some((name) => Boolean(config.targets[name].commands[kind])),
    );
    const hasArtifactEvidence =
      enabled.has("artifact") && (slice.requiredArtifacts ?? []).length > 0;
    const hasBrowserEvidence =
      enabled.has("browser") &&
      config.gates.browser.enabled &&
      Boolean(config.gates.browser.command && config.gates.browser.reportPath);
    const requiresVisualEvidence = (slice.evidence ?? []).some(
      (requirement) => requirement.required !== false && requirement.kind === "visual",
    );
    if (requiresVisualEvidence && !config.gates.browser.visual) {
      throw new Error(
        `Slice '${slice.id}' requires visual evidence but gates.browser.visual is not configured.`,
      );
    }
    if (!hasCommandEvidence && !hasArtifactEvidence && !hasBrowserEvidence) {
      throw new Error(
        `Slice '${slice.id}' has no deterministic evidence gate that is executable; AI review cannot establish a pass.`,
      );
    }
    if (enabled.has("artifact") && !(slice.requiredArtifacts ?? []).length) {
      throw new Error(`Slice '${slice.id}' enables the artifact gate without requiredArtifacts.`);
    }
    if (
      slice.docsImpact === "required" &&
      !(slice.docs?.length || slice.requiredArtifacts?.some((item) => item.startsWith("docs/")))
    ) {
      throw new Error(
        `Slice '${slice.id}' requires documentation impact but declares no docs artifact.`,
      );
    }
  }
  return plan;
}

export function validateDocuments(
  projectRoot: string,
  config: unknown,
  plan: unknown,
): { config: SliceForgeConfig; plan: SliceForgePlan } {
  const validatedConfig = validateConfig(config, projectRoot);
  return {
    config: validatedConfig,
    plan: validatePlan(plan, validatedConfig, projectRoot),
  };
}

export function validateProject(projectRoot: string): {
  config: SliceForgeConfig;
  plan: SliceForgePlan;
} {
  const config = loadConfig(projectRoot);
  return { config, plan: loadPlan(projectRoot, config) };
}
