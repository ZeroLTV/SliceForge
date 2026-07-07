import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { execCommand } from "../../src/utils/shell.js";
import { ReactNativeAdapter } from "../../src/adapters/react-native-adapter.js";
import { SliceForgeConfig } from "../../src/core/config.js";

jest.mock("../../src/utils/shell.js", () => ({
  execCommand: jest.fn(),
}));

describe("react native adapter", () => {
  const mockedExecCommand = execCommand as jest.MockedFunction<typeof execCommand>;
  const mockRoot = "/mock/rn-project";
  let config: SliceForgeConfig;

  beforeEach(() => {
    jest.clearAllMocks();
    config = {
      project: "MyRNApp",
      agent: { type: "api" },
      stack: { type: "react-native" },
      checks: {
        commands: {
          build: "tsc --noEmit",
          lint: "eslint . --ext .ts,.tsx",
          test: {
            unit: "jest",
            e2e: "detox test",
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
    mockedExecCommand.mockResolvedValueOnce({
      stdout: "No errors",
      stderr: "",
      exitCode: 0,
    });
    const adapter = new ReactNativeAdapter(config, mockRoot);
    const result = await adapter.build();

    expect(result.exitCode).toBe(0);
    expect(mockedExecCommand).toHaveBeenCalledWith("tsc --noEmit", {
      cwd: mockRoot,
    });
  });

  it("should run the configured lint command", async () => {
    mockedExecCommand.mockResolvedValueOnce({
      stdout: "Lint OK",
      stderr: "",
      exitCode: 0,
    });
    const adapter = new ReactNativeAdapter(config, mockRoot);
    const result = await adapter.lint();

    expect(result.exitCode).toBe(0);
    expect(mockedExecCommand).toHaveBeenCalledWith("eslint . --ext .ts,.tsx", {
      cwd: mockRoot,
    });
  });

  it("should run test commands with react-native fallbacks when none specified", async () => {
    config.checks.commands.test = {};
    mockedExecCommand.mockResolvedValueOnce({
      stdout: "Tests Passed",
      stderr: "",
      exitCode: 0,
    });

    const adapter = new ReactNativeAdapter(config, mockRoot);
    const result = await adapter.test("e2e");

    expect(result.exitCode).toBe(0);
    expect(mockedExecCommand).toHaveBeenCalledWith("detox test", {
      cwd: mockRoot,
    });
  });

  it("should consider the preview stack healthy (delegated to e2e gate)", async () => {
    const adapter = new ReactNativeAdapter(config, mockRoot);
    const healthy = await adapter.healthCheck();
    expect(healthy).toBe(true);
  });
});
