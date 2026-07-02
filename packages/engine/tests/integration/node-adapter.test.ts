import { jest, describe, it, expect } from "@jest/globals";
import { NodeAdapter } from "../../src/adapters/node-adapter.js";
import { SliceForgeConfig } from "../../src/core/config.js";
import * as path from "path";

describe("NodeAdapter integration smoke test", () => {
  const minimalNodePath = path.resolve(__dirname, "../../../../examples/minimal-node");

  const config: SliceForgeConfig = {
    project: "MinimalNodeSmokeTest",
    agent: { type: "api" },
    stack: { type: "node" },
    checks: {
      commands: {
        build: "npm run build",
        lint: "npm run lint",
        test: {
          unit: "npm run test:unit",
        },
      },
    },
    loop: {
      maxIterations: 1,
      maxRetriesPerSlice: 3,
      browserTest: { required: false, requirePreviewStack: false },
      testCaseGate: "skip",
    },
    paths: {
      backlog: "backlog.json",
      testCases: "testcases",
      guardrails: "guardrails.md",
      state: "state.json",
      lock: "lock",
    },
  };

  it("should execute real npm scripts in examples/minimal-node successfully", async () => {
    const adapter = new NodeAdapter(config, minimalNodePath);

    logger.debug = jest.fn(); // Suppress debug logging output

    const buildResult = await adapter.build();
    expect(buildResult.exitCode).toBe(0);
    expect(buildResult.stdout).toContain("Building project...");

    const lintResult = await adapter.lint();
    expect(lintResult.exitCode).toBe(0);
    expect(lintResult.stdout).toContain("Linting project...");

    const testResult = await adapter.test("unit");
    expect(testResult.exitCode).toBe(0);
    expect(testResult.stdout).toContain("Running unit tests...");
  });
});

// Mock logger in the scope of this test to not clutter Jest outputs
const logger = {
  debug: (...args: any[]) => {},
};
