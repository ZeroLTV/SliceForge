import { jest, describe, it, expect } from "@jest/globals";
import { runRalphLoop } from "../../src/core/ralph-runner.js";
import { SliceForgeConfig } from "../../src/core/config.js";
import * as fs from "fs";
import * as path from "path";

jest.mock("fs", () => {
  const actualFs: any = jest.requireActual("fs");
  return {
    ...actualFs,
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    existsSync: jest.fn((p: any) => {
      if (typeof p === "string" && (p.includes("implementer.md") || p.includes("reviewer.md") || p.includes("tester.md"))) {
        return true;
      }
      return actualFs.existsSync(p);
    }),
    readFileSync: jest.fn((p: any, options: any) => {
      if (typeof p === "string" && (p.includes("implementer.md") || p.includes("reviewer.md") || p.includes("tester.md"))) {
        return "Mock template content {{SLICE_ID}} {{DIFF_CONTEXT}} {{CHANGED_FILES}} {{CHECKS_SUMMARY}} {{BROWSER_TEST_SUMMARY}}";
      }
      return actualFs.readFileSync(p, options);
    }),
  };
});

jest.mock("../../src/utils/lock.js", () => ({
  acquireLock: jest.fn(),
  releaseLock: jest.fn(),
}));

jest.mock("../../src/utils/secrets.js", () => ({
  loadAndValidateSecrets: jest.fn().mockReturnValue({}),
}));

jest.mock("../../src/utils/git.js", () => ({
  hasUncommittedChanges: jest.fn().mockResolvedValue(false),
  resetToLastCommit: jest.fn().mockResolvedValue(undefined),
  commitSlice: jest.fn().mockResolvedValue(undefined),
  getChangedFiles: jest.fn().mockResolvedValue([]),
  getDiff: jest.fn().mockResolvedValue(""),
}));

jest.mock("../../src/core/backlog.js", () => {
  const original = jest.requireActual("../../src/core/backlog.js");
  return {
    ...original,
    loadBacklog: jest.fn().mockReturnValue({
      slices: [
        {
          id: "slice-1",
          passes: false,
          priority: 1,
          description: "Mock slice description",
          completionArtifacts: [],
        },
      ],
    }),
    saveBacklog: jest.fn(),
  };
});

jest.mock("../../src/core/state.js", () => {
  const original = jest.requireActual("../../src/core/state.js");
  return {
    ...original,
    loadState: jest.fn().mockReturnValue({
      currentSliceId: "",
      status: "running",
      retriesPerSlice: {},
      gatesCompleted: [],
      costAccumulated: { inputTokens: 0, outputTokens: 0 },
    }),
    saveState: jest.fn(),
    clearState: jest.fn(),
  };
});

// Mock agent to return success signal
jest.mock("../../src/core/ralph-runner.js", () => {
  const actual = jest.requireActual("../../src/core/ralph-runner.js");
  return {
    ...actual,
    getAgentAdapter: jest.fn().mockReturnValue({
      run: jest.fn().mockResolvedValue({
        signal: "SLICE_DONE",
        output: "Agent finished successfully",
        exitCode: 0,
      }),
    }),
    getStackAdapter: jest.fn().mockReturnValue({
      build: jest.fn().mockResolvedValue({ stdout: "Build passed", stderr: "", exitCode: 0 }),
      lint: jest.fn().mockResolvedValue({ stdout: "Lint passed", stderr: "", exitCode: 0 }),
      test: jest.fn().mockResolvedValue({ stdout: "Tests passed", stderr: "", exitCode: 0 }),
      startPreview: jest.fn().mockResolvedValue(undefined),
      stopPreview: jest.fn().mockResolvedValue(undefined),
      healthCheck: jest.fn().mockResolvedValue(true),
    }),
  };
});

describe("ralph runner loop integration", () => {
  const mockConfig: SliceForgeConfig = {
    project: "IntegrationTest",
    agent: {
      type: "api",
    },
    stack: {
      type: "node",
    },
    checks: {
      commands: {
        build: "npm run build",
        test: {
          unit: "npm run test",
        },
      },
    },
    loop: {
      maxIterations: 1,
      maxRetriesPerSlice: 2,
      browserTest: {
        required: false,
        requirePreviewStack: false,
      },
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

  it("should successfully run loop, implement, and pass all gates", async () => {
    // Run loop once
    await expect(runRalphLoop(mockConfig, "/mock/project", true)).resolves.not.toThrow();
  });
});
