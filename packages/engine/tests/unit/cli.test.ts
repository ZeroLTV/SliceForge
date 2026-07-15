import { jest, describe, it, expect } from "@jest/globals";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cliModule: any;

const mockCommandInstance = {
  name: jest.fn().mockReturnThis(),
  description: jest.fn().mockReturnThis(),
  version: jest.fn().mockReturnThis(),
  command: jest.fn().mockReturnThis(),
  option: jest.fn().mockReturnThis(),
  action: jest.fn().mockReturnThis(),
  parse: jest.fn(),
};

jest.mock("commander", () => ({
  Command: jest.fn(() => mockCommandInstance),
}));

jest.mock("../../src/core/config", () => ({
  loadConfig: jest.fn(),
}));

jest.mock("../../src/core/ralph-runner", () => ({
  runRalphLoop: jest.fn(),
  approveSlice: jest.fn(),
}));

jest.mock("../../src/core/testgen-runner", () => ({
  runTestGenLoop: jest.fn(),
}));

jest.mock("../../src/core/backlog", () => ({
  loadBacklog: jest.fn(),
  allSlicesPass: jest.fn(),
}));

jest.mock("../../src/core/state", () => ({
  loadState: jest.fn(),
}));

jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    success: jest.fn(),
    section: jest.fn(),
    setLogFile: jest.fn(),
  },
}));

cliModule = require("../../src/cli/index");

describe("CLI command registration", () => {
  it("should set program metadata (name, description, version)", () => {
    expect(mockCommandInstance.name).toHaveBeenCalledWith("sliceforge");
    expect(mockCommandInstance.description).toHaveBeenCalledWith(
      expect.stringContaining("SliceForge"),
    );
    expect(mockCommandInstance.version).toHaveBeenCalledWith("1.0.0");
  });

  it("should register the 'init' command", () => {
    expect(mockCommandInstance.command).toHaveBeenCalledWith("init");
  });

  it("should register the 'loop' command with --max option", () => {
    expect(mockCommandInstance.command).toHaveBeenCalledWith("loop");
    expect(mockCommandInstance.option).toHaveBeenCalledWith(
      "-m, --max <iterations>",
      "Maximum loop iterations override",
    );
  });

  it("should register the 'once' command", () => {
    expect(mockCommandInstance.command).toHaveBeenCalledWith("once");
  });

  it("should register the 'testgen' command with --once option", () => {
    expect(mockCommandInstance.command).toHaveBeenCalledWith("testgen");
    expect(mockCommandInstance.option).toHaveBeenCalledWith(
      "-o, --once",
      "Generate test cases for exactly one tag and stop",
    );
  });

  it("should register the 'status' command", () => {
    expect(mockCommandInstance.command).toHaveBeenCalledWith("status");
  });

  it("should register the 'approve' command with sliceId argument", () => {
    expect(mockCommandInstance.command).toHaveBeenCalledWith(
      "approve <sliceId>",
    );
  });

  it("should register all six commands", () => {
    const commandCalls = (mockCommandInstance.command as jest.Mock).mock.calls.map(
      (call: string[]) => call[0],
    );

    expect(commandCalls).toContain("init");
    expect(commandCalls).toContain("loop");
    expect(commandCalls).toContain("once");
    expect(commandCalls).toContain("testgen");
    expect(commandCalls).toContain("status");
    expect(commandCalls).toContain("approve <sliceId>");
    expect(commandCalls).toHaveLength(6);
  });

  it("should call program.parse so Commander processes argv", () => {
    expect(mockCommandInstance.parse).toHaveBeenCalled();
  });
});

describe("CLI module import safety", () => {
  it("should not throw when imported", () => {
    // Already imported at top of file — if it threw, this suite would not run.
    expect(true).toBe(true);
  });
});

describe("parseGitMode", () => {
  it("returns undefined for undefined value", () => {
    expect(
      cliModule.parseGitMode(undefined, ["refuse", "stash"], "--git-dirty-mode"),
    ).toBeUndefined();
  });

  it("returns the value when allowed", () => {
    expect(
      cliModule.parseGitMode("stash", ["refuse", "stash"], "--git-dirty-mode"),
    ).toBe("stash");
  });

  it("throws for an invalid value", () => {
    expect(() =>
      cliModule.parseGitMode(
        "abc",
        ["refuse", "stash", "force-reset"],
        "--git-dirty-mode",
      ),
    ).toThrow(/Invalid --git-dirty-mode value/);
  });
});

describe("applyGitOptions", () => {
  const baseConfig = {
    project: "test",
    agent: { type: "api" },
    stack: { type: "node" },
    checks: { commands: { build: "npm run build", test: { unit: "npm test" } } },
    loop: { maxIterations: 5, maxRetriesPerSlice: 2, browserTest: { required: false, requirePreviewStack: false }, testCaseGate: "skip" },
    paths: { backlog: "b.json", testCases: "tc", guardrails: "g.md", state: "s.json", lock: "l" },
  };

  it("returns a new config object (does not mutate original)", () => {
    const result = cliModule.applyGitOptions(baseConfig, { gitDirtyMode: "stash" });
    expect(result).not.toBe(baseConfig);
    expect(baseConfig.git).toBeUndefined();
    expect(result.git.dirtyMode).toBe("stash");
  });

  it("merges git overrides with existing git config", () => {
    const configWithGit = { ...baseConfig, git: { autoCommit: false } };
    const result = cliModule.applyGitOptions(configWithGit, { gitRollbackMode: "none" });
    expect(result.git.autoCommit).toBe(false);
    expect(result.git.rollbackMode).toBe("none");
  });

  it("passes through config unchanged when no git options", () => {
    const result = cliModule.applyGitOptions(baseConfig, {});
    expect(result.git).toEqual({});
    expect(result.project).toBe("test");
  });

  it("handles --no-git-auto-commit flag", () => {
    const result = cliModule.applyGitOptions(baseConfig, { gitAutoCommit: false });
    expect(result.git.autoCommit).toBe(false);
  });
});
