import { describe, expect, it } from "@jest/globals";
import { routeAgent, sliceComplexity, taskComplexity } from "../../src/core/agent-router";
import type { SliceDefinition, SliceForgeConfig, TaskRequest } from "../../src/core/contracts";

function config(): SliceForgeConfig {
  return {
    schemaVersion: 1,
    project: "routing-fixture",
    agents: {
      implementer: { type: "codex", model: "base-implementer" },
      testgen: { type: "codex", model: "base-testgen" },
      reviewer: { type: "codex", model: "base-reviewer" },
    },
    targets: {
      web: { root: "apps/web", preset: "node", commands: {} },
      api: { root: "services/api", preset: "dotnet", commands: {} },
    },
    isolation: { mode: "worktree" },
    gates: {
      order: ["unit"],
      browser: { enabled: false },
      review: { enabled: false, advisory: true },
    },
    policies: { protectedPatterns: [], maxRetries: 1 },
    routing: {
      fallbackRole: "implementer",
      rules: [
        {
          role: "planner",
          targets: ["web"],
          maxComplexity: 2,
          agent: { type: "claude", model: "web-planner" },
        },
        {
          role: "implementer",
          presets: ["dotnet"],
          minComplexity: 3,
          agent: { type: "cursor", model: "dotnet-complex" },
        },
        {
          role: "reviewer",
          targets: ["web"],
          agent: { type: "claude", model: "web-reviewer" },
        },
      ],
    },
    reporting: { retainRuns: 10, maxLogBytes: 65_536 },
    ci: { reportOnly: true },
  };
}

describe("agent router", () => {
  it("selects the first role/target/preset/complexity rule and otherwise uses the role fallback", () => {
    const value = config();
    expect(routeAgent(value, "planner", { targets: ["web"], complexity: 2 })?.model).toBe(
      "web-planner",
    );
    expect(routeAgent(value, "planner", { targets: ["web"], complexity: 3 })).toBeUndefined();
    expect(routeAgent(value, "implementer", { targets: ["api"], complexity: 3 })?.model).toBe(
      "dotnet-complex",
    );
    expect(routeAgent(value, "implementer", { targets: ["api"], complexity: 2 })?.model).toBe(
      "base-implementer",
    );
    expect(routeAgent(value, "reviewer", { targets: ["web"], complexity: 5 })?.model).toBe(
      "web-reviewer",
    );
    expect(routeAgent(value, "reviewer", { targets: ["api"], complexity: 5 })?.model).toBe(
      "base-reviewer",
    );
  });

  it("derives bounded auditable complexity from task and slice contracts", () => {
    const task: TaskRequest = {
      id: "task-1",
      request: Array.from({ length: 50 }, () => "behavior").join(" "),
      targets: ["web", "api"],
      constraints: ["one", "two", "three"],
      priority: 1,
      attachments: [{ id: "image", kind: "image", source: "screen.png" }],
      createdAt: new Date(0).toISOString(),
    };
    expect(taskComplexity(task)).toBe(5);

    const slice: SliceDefinition = {
      id: "complex",
      title: "Complex slice",
      description: "x".repeat(600),
      priority: 1,
      dependsOn: ["a", "b"],
      targets: ["web", "api"],
      acceptance: [
        { id: "AC-1", expected: "one" },
        { id: "AC-2", expected: "two" },
        { id: "AC-3", expected: "three" },
      ],
      allowedPaths: ["**/*"],
      requiredGates: ["build", "lint", "unit", "integration"],
    };
    expect(sliceComplexity(slice)).toBe(5);
  });
});
