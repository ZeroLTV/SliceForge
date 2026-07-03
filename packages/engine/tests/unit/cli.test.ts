import { jest, describe, it, expect } from "@jest/globals";

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

require("../../src/cli/index");

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
