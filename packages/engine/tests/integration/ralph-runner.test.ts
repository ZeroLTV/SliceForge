import { jest, describe, it, expect } from "@jest/globals";
import { SliceForgeConfig } from "../../src/core/config.js";
import * as fs from "fs";
import * as path from "path";

jest.mock("fs", () => {
  const actualFs = jest.requireActual("fs") as typeof fs;
  return {
    ...actualFs,
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    appendFileSync: jest.fn(),
    existsSync: jest.fn((p: fs.PathLike) => {
      const pathStr = p.toString();
      if (
        pathStr.includes("implementer.md") ||
        pathStr.includes("reviewer.md") ||
        pathStr.includes("tester.md") ||
        pathStr.includes("testgen.md") ||
        pathStr.includes("backlog.json") ||
        pathStr.includes("state.json") ||
        pathStr.includes("guardrails.md") ||
        pathStr.includes("lock")
      ) {
        return true;
      }
      return actualFs.existsSync(p);
    }),
    readFileSync: jest.fn((p: fs.PathOrFileDescriptor, options: any) => {
      const pathStr = typeof p === "string" ? p : String(p);
      if (
        pathStr.includes("implementer.md") ||
        pathStr.includes("reviewer.md") ||
        pathStr.includes("tester.md") ||
        pathStr.includes("testgen.md")
      ) {
        return "Mock template content {{SLICE_ID}} {{DIFF_CONTEXT}} {{CHANGED_FILES}} {{CHECKS_SUMMARY}} {{BROWSER_TEST_SUMMARY}} {{SLICE_DESCRIPTION}} {{DOCS_LIST}} {{ACCEPTANCE_TAGS}} {{PRIOR_FAILURES}} {{COMPLETION_ARTIFACTS}}";
      }
      if (pathStr.includes("backlog.json")) {
        return JSON.stringify({
          slices: [
            {
              id: "slice-1",
              passes: false,
              priority: 1,
              description: "Mock slice description",
              completionArtifacts: [],
            },
          ],
        });
      }
      return actualFs.readFileSync(p, options);
    }),
    mkdirSync: jest.fn(),
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

jest.mock("../../src/core/state.js", () => {
  const original = jest.requireActual("../../src/core/state.js") as object;
  return {
    ...original,
    loadState: jest.fn().mockReturnValue({
      currentSliceId: "",
      status: "running" as const,
      retriesPerSlice: {},
      gatesCompleted: [],
      costAccumulated: { inputTokens: 0, outputTokens: 0 },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    saveState: jest.fn(),
    clearState: jest.fn(),
  };
});

jest.mock("../../src/agents/claude-code-agent.js", () => ({
  ClaudeCodeAgent: jest.fn().mockImplementation(() => ({
    run: jest.fn().mockResolvedValue({
      signal: "SLICE_DONE",
      output: "Agent finished successfully",
      exitCode: 0,
    }),
  })),
}));

jest.mock("../../src/agents/api-agent.js", () => ({
  ApiAgent: jest.fn().mockImplementation(() => ({
    run: jest.fn().mockResolvedValue({
      signal: "SLICE_DONE",
      output: "Agent finished successfully",
      exitCode: 0,
    }),
  })),
}));

jest.mock("../../src/adapters/node-adapter.js", () => ({
  NodeAdapter: jest.fn().mockImplementation(() => ({
    build: jest.fn().mockResolvedValue({
      stdout: "Build passed",
      stderr: "",
      exitCode: 0,
    }),
    lint: jest.fn().mockResolvedValue({
      stdout: "Lint passed",
      stderr: "",
      exitCode: 0,
    }),
    test: jest.fn().mockResolvedValue({
      stdout: "Tests passed",
      stderr: "",
      exitCode: 0,
    }),
    startPreview: jest.fn().mockResolvedValue(undefined),
    stopPreview: jest.fn().mockResolvedValue(undefined),
    healthCheck: jest.fn().mockResolvedValue(true),
  })),
}));

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
    const { runRalphLoop } = await import("../../src/core/ralph-runner.js");
    await expect(
      runRalphLoop(mockConfig, "/mock/project", true),
    ).resolves.not.toThrow();
  });
});
