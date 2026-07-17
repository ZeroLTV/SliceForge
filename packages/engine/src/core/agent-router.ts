import type {
  AgentDefinition,
  AgentRole,
  SliceDefinition,
  SliceForgeConfig,
  TaskRequest,
} from "./contracts.js";

export interface AgentRouteContext {
  targets: string[];
  complexity: number;
}

function clampComplexity(value: number): number {
  return Math.max(1, Math.min(5, Math.round(value)));
}

export function taskComplexity(task: TaskRequest): number {
  const words = task.request.trim().split(/\s+/).filter(Boolean).length;
  return clampComplexity(
    1 +
      (task.targets.length > 1 ? 1 : 0) +
      (task.attachments.length > 0 ? 1 : 0) +
      (words > 40 ? 1 : 0) +
      (task.constraints.length > 2 ? 1 : 0),
  );
}

export function sliceComplexity(slice: SliceDefinition): number {
  return clampComplexity(
    1 +
      (slice.targets.length > 1 ? 1 : 0) +
      (slice.acceptance.length > 2 ? 1 : 0) +
      ((slice.requiredGates?.length ?? 0) > 3 ? 1 : 0) +
      ((slice.description?.length ?? 0) > 500 || (slice.dependsOn?.length ?? 0) > 1 ? 1 : 0),
  );
}

export function routeAgent(
  config: SliceForgeConfig,
  role: AgentRole,
  context: AgentRouteContext,
): AgentDefinition | undefined {
  const presets = new Set(context.targets.map((target) => config.targets[target]?.preset));
  const matching = (config.routing?.rules ?? []).find((rule) => {
    if (rule.role !== role) return false;
    if (rule.targets && !context.targets.every((target) => rule.targets!.includes(target)))
      return false;
    if (rule.presets && ![...presets].every((preset) => preset && rule.presets!.includes(preset))) {
      return false;
    }
    if (rule.minComplexity !== undefined && context.complexity < rule.minComplexity) return false;
    if (rule.maxComplexity !== undefined && context.complexity > rule.maxComplexity) return false;
    return true;
  });
  return matching?.agent ?? config.agents[role];
}
