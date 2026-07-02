import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { execCommand } from "../../src/utils/shell.js";
import { DotnetAdapter } from "../../src/adapters/dotnet-adapter.js";
import { SliceForgeConfig } from "../../src/core/config.js";

jest.mock("../../src/utils/shell.js", () => ({
  execCommand: jest.fn(),
}));

describe("dotnet adapter", () => {
  const mockedExecCommand = execCommand as jest.MockedFunction<typeof execCommand>;
  const mockRoot = "/mock/dotnet-project";
  let config: SliceForgeConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      project: "MyDotnetApp",
      agent: { type: "api" },
      stack: { type: "dotnet" },
      checks: {
        commands: {
          build: "dotnet build --no-restore",
          lint: "dotnet format --verify-no-changes",
          test: {
            unit: "dotnet test --filter Category=Unit",
          },
        },
      },
      loop: {
        maxIterations: 10,
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
  });

  it("should run the configured build command", async () => {
    mockedExecCommand.mockResolvedValueOnce({ stdout: "Build Succeeded", stderr: "", exitCode: 0 });
    const adapter = new DotnetAdapter(config, mockRoot);
    const result = await adapter.build();

    expect(result.exitCode).toBe(0);
    expect(mockedExecCommand).toHaveBeenCalledWith("dotnet build --no-restore", { cwd: mockRoot });
  });

  it("should run the configured lint command", async () => {
    mockedExecCommand.mockResolvedValueOnce({ stdout: "Lint Succeeded", stderr: "", exitCode: 0 });
    const adapter = new DotnetAdapter(config, mockRoot);
    const result = await adapter.lint();

    expect(result.exitCode).toBe(0);
    expect(mockedExecCommand).toHaveBeenCalledWith("dotnet format --verify-no-changes", { cwd: mockRoot });
  });

  it("should run test commands with fallback when none specified in config", async () => {
    // Clear custom test commands in config to test fallback
    config.checks.commands.test = {};
    mockedExecCommand.mockResolvedValueOnce({ stdout: "Tests Passed", stderr: "", exitCode: 0 });

    const adapter = new DotnetAdapter(config, mockRoot);
    const result = await adapter.test("integration");

    expect(result.exitCode).toBe(0);
    expect(mockedExecCommand).toHaveBeenCalledWith("dotnet test --filter Category=Integration", {
      cwd: mockRoot,
    });
  });
});
