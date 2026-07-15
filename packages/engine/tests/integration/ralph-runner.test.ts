import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { SliceForgeConfig } from "../../src/core/config.js";
import * as fs from "fs";
import * as path from "path";
import * as git from "../../src/utils/git.js";
import * as stateMod from "../../src/core/state.js";

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
  resetToSha: jest.fn().mockResolvedValue(undefined),
  stashChanges: jest.fn().mockResolvedValue(true),
  getCurrentSha: jest.fn().mockResolvedValue("sha-default"),
  commitSlice: jest.fn().mockResolvedValue(undefined),
  getChangedFiles: jest.fn().mockResolvedValue([]),
  getDiff: jest.fn().mockResolvedValue(""),
}));

jest.mock("../../src/utils/schema-loader.js", () => ({
  loadSchema: jest.fn(() => ({})),
  createValidator: jest.fn(() => () => true),
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
    run: jest.fn()
      .mockResolvedValueOnce({
        signal: "SLICE_DONE",
        output: "Agent finished successfully",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        signal: "REVIEW_PASS",
        output: "Agent finished successfully",
        exitCode: 0,
      })
      .mockResolvedValue({
        signal: "REVIEW_PASS",
        output: "Agent finished successfully",
        exitCode: 0,
      }),
  })),
}));

jest.mock("../../src/agents/api-agent.js", () => ({
  ApiAgent: jest.fn().mockImplementation(() => ({
    run: jest.fn()
      .mockResolvedValueOnce({
        signal: "SLICE_DONE",
        output: "Agent finished successfully",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        signal: "REVIEW_PASS",
        output: "Agent finished successfully",
        exitCode: 0,
      })
      .mockResolvedValue({
        signal: "REVIEW_PASS",
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

describe("ralph runner git safety model", () => {
  const baseConfig: SliceForgeConfig = {
    project: "IntegrationTest",
    agent: { type: "api" },
    stack: { type: "node" },
    checks: {
      commands: { build: "npm run build", test: { unit: "npm run test" } },
    },
    loop: {
      maxIterations: 5,
      maxRetriesPerSlice: 2,
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

  const mockedGit = git as jest.Mocked<typeof git>;
  const mockedState = stateMod as jest.Mocked<typeof stateMod>;

  function defaultState(overrides: Record<string, unknown> = {}) {
    return {
      currentSliceId: "",
      status: "running" as const,
      retriesPerSlice: {},
      gatesCompleted: [],
      costAccumulated: { inputTokens: 0, outputTokens: 0 },
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockedGit.hasUncommittedChanges.mockResolvedValue(false);
    mockedGit.getCurrentSha.mockResolvedValue("sha-default");
    mockedGit.resetToLastCommit.mockResolvedValue(undefined);
    mockedGit.resetToSha.mockResolvedValue(undefined);
    mockedGit.stashChanges.mockResolvedValue(true);
    mockedGit.commitSlice.mockResolvedValue(undefined);
    mockedState.loadState.mockReturnValue(defaultState());
    mockedState.saveState.mockReturnValue(undefined);
    mockedState.clearState.mockReturnValue(undefined);
  });

  it("refuse mode: dirty tree without ownership throws REFUSE_MSG", async () => {
    mockedGit.hasUncommittedChanges.mockResolvedValue(true);
    mockedState.loadState.mockReturnValue(defaultState());

    const { runRalphLoop } = await import("../../src/core/ralph-runner.js");
    await expect(
      runRalphLoop({ ...baseConfig, git: { dirtyMode: "refuse" } }, "/mock/project", true),
    ).rejects.toThrow(/requires a clean working tree/);
    expect(mockedGit.resetToLastCommit).not.toHaveBeenCalled();
    expect(mockedGit.resetToSha).not.toHaveBeenCalled();
  });

  it("pending_approval: returns early even when dirty (no REFUSE_MSG)", async () => {
    mockedGit.hasUncommittedChanges.mockResolvedValue(true);
    mockedState.loadState.mockReturnValue(
      defaultState({ status: "pending_approval", currentSliceId: "slice-1" }),
    );

    const { runRalphLoop } = await import("../../src/core/ralph-runner.js");
    await expect(
      runRalphLoop(baseConfig, "/mock/project", true),
    ).resolves.not.toThrow();
    expect(mockedGit.resetToLastCommit).not.toHaveBeenCalled();
  });

  it("owned-dirty resume: resets to baseSha, never reset --hard HEAD", async () => {
    mockedGit.hasUncommittedChanges.mockResolvedValue(true);
    mockedGit.getCurrentSha.mockResolvedValue("sha-owned");
    mockedState.loadState.mockReturnValue(
      defaultState({
        status: "running",
        currentSliceId: "slice-1",
        git: { baseSha: "sha-owned", sliceId: "slice-1" },
      }),
    );

    const { runRalphLoop } = await import("../../src/core/ralph-runner.js");
    await expect(
      runRalphLoop(baseConfig, "/mock/project", true),
    ).resolves.not.toThrow();
    expect(mockedGit.resetToSha).toHaveBeenCalledWith(
      "/mock/project",
      "sha-owned",
      expect.any(Object),
    );
    expect(mockedGit.resetToLastCommit).not.toHaveBeenCalled();
  });

  it("owned-dirty + rollbackMode none: refuses to run on dirty tree", async () => {
    mockedGit.hasUncommittedChanges.mockResolvedValue(true);
    mockedGit.getCurrentSha.mockResolvedValue("sha-owned");
    mockedState.loadState.mockReturnValue(
      defaultState({
        status: "running",
        currentSliceId: "slice-1",
        git: { baseSha: "sha-owned", sliceId: "slice-1" },
      }),
    );

    const { runRalphLoop } = await import("../../src/core/ralph-runner.js");
    await expect(
      runRalphLoop(
        { ...baseConfig, git: { rollbackMode: "none" } },
        "/mock/project",
        true,
      ),
    ).rejects.toThrow(/rollbackMode=none/);
  });

  it("dirtyMode stash (non-owned): calls stashChanges", async () => {
    mockedGit.hasUncommittedChanges
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    mockedState.loadState.mockReturnValue(defaultState());

    const { runRalphLoop } = await import("../../src/core/ralph-runner.js");
    await expect(
      runRalphLoop(
        { ...baseConfig, git: { dirtyMode: "stash" } },
        "/mock/project",
        true,
      ),
    ).resolves.not.toThrow();
    expect(mockedGit.stashChanges).toHaveBeenCalled();
    expect(mockedGit.resetToLastCommit).not.toHaveBeenCalled();
  });

  it("autoCommit false: marks pending_manual_commit and stops the loop", async () => {
    mockedGit.hasUncommittedChanges.mockResolvedValue(false);
    mockedState.loadState.mockReturnValue(defaultState());

    const { runRalphLoop } = await import("../../src/core/ralph-runner.js");
    await expect(
      runRalphLoop(
        { ...baseConfig, git: { autoCommit: false } },
        "/mock/project",
        false,
      ),
    ).resolves.not.toThrow();

    const lastSave = mockedState.saveState.mock.calls.at(-1);
    expect(lastSave?.[1].status).toBe("pending_manual_commit");
    expect(mockedGit.commitSlice).not.toHaveBeenCalled();

    // Verify the loop stopped after 1 slice — if a second iteration ran,
    // ensureCleanForSlice would call getCurrentSha again for the new baseSha.
    // With a single slice, getCurrentSha is called once (from ensureCleanForSlice).
    const getShaCallCount = mockedGit.getCurrentSha.mock.calls.length;
    expect(getShaCallCount).toBeLessThanOrEqual(1);
  });

  it("transactional: commit failure restores original backlog bytes", async () => {
    mockedGit.hasUncommittedChanges.mockResolvedValue(false);
    mockedState.loadState.mockReturnValue(defaultState());
    mockedGit.commitSlice.mockRejectedValue(new Error("commit failed"));

    const { runRalphLoop } = await import("../../src/core/ralph-runner.js");
    await expect(
      runRalphLoop(baseConfig, "/mock/project", true),
    ).rejects.toThrow("commit failed");

    const writeCalls = (fs.writeFileSync as jest.Mock).mock.calls;
    const restored = writeCalls.some(
      (call) =>
        String(call[0]).includes("backlog") &&
        String(call[1]).includes('"passes":false'),
    );
    expect(restored).toBe(true);
  });

  it("pending_manual_commit resume: continues only when tree is clean", async () => {
    mockedGit.hasUncommittedChanges.mockResolvedValue(false);
    mockedState.loadState.mockReturnValue(
      defaultState({ status: "pending_manual_commit" }),
    );

    const { runRalphLoop } = await import("../../src/core/ralph-runner.js");
    await expect(
      runRalphLoop(baseConfig, "/mock/project", true),
    ).resolves.not.toThrow();
    const resumedClean = mockedState.saveState.mock.calls.some(
      (call) => call[1].status === "running" && call[1].git === undefined,
    );
    expect(resumedClean).toBe(true);
    expect(mockedGit.resetToLastCommit).not.toHaveBeenCalled();
  });
});
