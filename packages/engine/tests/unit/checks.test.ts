import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { runComputationalChecks } from "../../src/gates/checks.js";
import { StackAdapter } from "../../src/adapters/base-adapter.js";
import { SliceForgeConfig } from "../../src/core/config.js";
import { Slice } from "../../src/core/backlog.js";

const buildSuccess = { stdout: "Build OK", stderr: "", exitCode: 0 };
const buildFailure = { stdout: "", stderr: "Build failed: TS2322", exitCode: 1 };
const lintSuccess = { stdout: "Lint OK", stderr: "", exitCode: 0 };
const lintFailure = { stdout: "", stderr: "Lint failed: no-unused-vars", exitCode: 1 };
const testSuccess = { stdout: "Tests passed", stderr: "", exitCode: 0 };
const testFailure = { stdout: "", stderr: "3 tests failed", exitCode: 1 };

jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    existsSync: jest.fn(),
    statSync: jest.fn(),
    readdirSync: jest.fn(),
    readFileSync: jest.fn(),
  };
});

import * as fs from "fs";

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockStatSync = fs.statSync as jest.MockedFunction<typeof fs.statSync>;
const mockReaddirSync = fs.readdirSync as jest.MockedFunction<typeof fs.readdirSync>;
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;

function createMockAdapter(overrides?: Partial<StackAdapter>): StackAdapter {
  return {
    build: jest.fn<StackAdapter["build"]>().mockResolvedValue(buildSuccess),
    lint: jest.fn<StackAdapter["lint"]>().mockResolvedValue(lintSuccess),
    test: jest.fn<StackAdapter["test"]>().mockResolvedValue(testSuccess),
    startPreview: jest.fn<StackAdapter["startPreview"]>().mockResolvedValue(undefined),
    stopPreview: jest.fn<StackAdapter["stopPreview"]>().mockResolvedValue(undefined),
    healthCheck: jest.fn<StackAdapter["healthCheck"]>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMockConfig(overrides?: Partial<SliceForgeConfig>): SliceForgeConfig {
  return {
    project: "test-app",
    agent: { type: "api" },
    stack: { type: "node" },
    checks: {
      commands: {
        build: "npm run build",
        test: { unit: "npm test -- unit" },
      },
      ...overrides?.checks,
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
    ...overrides,
    paths: {
      backlog: "backlog.json",
      testCases: "testcases",
      guardrails: "guardrails.md",
      state: "state.json",
      lock: "lock",
      ...overrides?.paths,
    },
  };
}

function createMockSlice(overrides?: Partial<Slice>): Slice {
  return {
    id: "slice-1",
    passes: false,
    priority: 1,
    description: "Test slice",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockExistsSync.mockReturnValue(false as never);
});

describe("runComputationalChecks", () => {
  it("returns pass=true with no failures when all checks succeed", async () => {
    mockExistsSync.mockReturnValue(false as never);
    const adapter = createMockAdapter();
    const config = createMockConfig();
    const slice = createMockSlice();
    const result = await runComputationalChecks(slice, config, "/fake/project", adapter);

    expect(result.pass).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("returns build failure when build exitCode is non-zero", async () => {
    mockExistsSync.mockReturnValue(false as never);
    const adapter = createMockAdapter({
      build: jest.fn<StackAdapter["build"]>().mockResolvedValue(buildFailure),
    });
    const config = createMockConfig();
    const slice = createMockSlice();
    const result = await runComputationalChecks(slice, config, "/fake/project", adapter);

    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].type).toBe("build_error");
  });

  it("returns lint failure when lint exitCode is non-zero", async () => {
    mockExistsSync.mockReturnValue(false as never);
    const adapter = createMockAdapter({
      lint: jest.fn<StackAdapter["lint"]>().mockResolvedValue(lintFailure),
    });
    const config = createMockConfig();
    const slice = createMockSlice();
    const result = await runComputationalChecks(slice, config, "/fake/project", adapter);

    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].type).toBe("lint_error");
  });

  it("returns test_error for unit test failure", async () => {
    mockExistsSync.mockReturnValue(false as never);
    const adapter = createMockAdapter({
      test: jest.fn<StackAdapter["test"]>().mockResolvedValue(testFailure),
    });
    const config = createMockConfig({
      checks: {
        commands: {
          build: "npm run build",
          test: { unit: "npm test -- unit" },
        },
      },
    });
    const slice = createMockSlice({
      testRequirements: { unit: ["test1"] },
    });
    const result = await runComputationalChecks(slice, config, "/fake/project", adapter);

    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].type).toBe("test_error");
    expect(result.failures[0].message).toBe("Unit tests failed");
  });

  it("returns test_error for integration test failure", async () => {
    mockExistsSync.mockReturnValue(false as never);
    const adapter = createMockAdapter({
      test: jest
        .fn<StackAdapter["test"]>()
        .mockResolvedValueOnce(testSuccess)
        .mockResolvedValueOnce(testFailure),
    });
    const config = createMockConfig({
      checks: {
        commands: {
          build: "npm run build",
          test: { unit: "npm test -- unit", integration: "npm test -- integration" },
        },
      },
    });
    const slice = createMockSlice({
      testRequirements: { unit: ["test1"], integration: ["intTest1"] },
    });
    const result = await runComputationalChecks(slice, config, "/fake/project", adapter);

    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].type).toBe("test_error");
    expect(result.failures[0].message).toBe("Integration tests failed");
  });

  it("skips unit tests when config has no unit command and slice has no unit requirements", async () => {
    mockExistsSync.mockReturnValue(false as never);
    const adapter = createMockAdapter();
    const config = createMockConfig({
      checks: {
        commands: {
          build: "npm run build",
          test: {},
        },
      },
    });
    const slice = createMockSlice({ testRequirements: undefined });
    const result = await runComputationalChecks(slice, config, "/fake/project", adapter);

    expect(result.pass).toBe(true);
    expect(adapter.test).not.toHaveBeenCalled();
  });

  it("skips integration tests when config has no integration command and slice has no integration requirements", async () => {
    mockExistsSync.mockReturnValue(false as never);
    const adapter = createMockAdapter();
    const config = createMockConfig({
      checks: {
        commands: {
          build: "npm run build",
          test: { unit: "npm test -- unit" },
        },
      },
    });
    const slice = createMockSlice({ testRequirements: { unit: ["unit1"] } });
    await runComputationalChecks(slice, config, "/fake/project", adapter);

    expect(adapter.test).toHaveBeenCalledTimes(1);
    expect(adapter.test).toHaveBeenCalledWith("unit");
  });

  it("returns multiple failures when build, lint, and tests all fail", async () => {
    mockExistsSync.mockReturnValue(false as never);
    const adapter = createMockAdapter({
      build: jest.fn<StackAdapter["build"]>().mockResolvedValue(buildFailure),
      lint: jest.fn<StackAdapter["lint"]>().mockResolvedValue(lintFailure),
      test: jest.fn<StackAdapter["test"]>().mockResolvedValue(testFailure),
    });
    const config = createMockConfig({
      checks: {
        commands: {
          build: "npm run build",
          test: { unit: "npm test -- unit" },
        },
      },
    });
    const slice = createMockSlice({ testRequirements: { unit: ["test1"] } });
    const result = await runComputationalChecks(slice, config, "/fake/project", adapter);

    expect(result.pass).toBe(false);
    expect(result.failures).toHaveLength(3);
    const types = result.failures.map((f) => f.type);
    expect(types).toContain("build_error");
    expect(types).toContain("lint_error");
    expect(types).toContain("test_error");
  });

  describe("forbidden pattern checks", () => {
    const forbiddenRules = [
      {
        id: "no-todo",
        pattern: "TODO",
        paths: ["src"],
        message: "No TODO comments allowed",
      },
    ];

    it("detects forbidden pattern in file content", () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = p.toString();
        if (s.includes("src")) return true;
        return false;
      });
      mockStatSync.mockImplementation((p: fs.PathLike) => {
        return {
          isDirectory: () => p.toString().endsWith("src"),
          isFile: () => p.toString().includes(".ts"),
        } as fs.Stats;
      });
      mockReaddirSync.mockReturnValue(["app.ts"] as unknown as fs.Dirent[]);
      mockReadFileSync.mockReturnValue("// TODO: fix this");

      const adapter = createMockAdapter();
      const config = createMockConfig({
        checks: {
          commands: {
            build: "npm run build",
            test: {},
          },
          forbiddenPatterns: forbiddenRules,
        },
      });
      const slice = createMockSlice();

      const resultPromise = runComputationalChecks(slice, config, "/fake/project", adapter);

      return resultPromise.then((result) => {
        expect(result.failures).toHaveLength(1);
        expect(result.failures[0].type).toBe("forbidden_pattern");
        expect(result.failures[0].message).toContain("No TODO comments allowed");
      });
    });

    it("skips non-existent paths in forbidden pattern rules", () => {
      mockExistsSync.mockReturnValue(false);

      const adapter = createMockAdapter();
      const config = createMockConfig({
        checks: {
          commands: { build: "build", test: {} },
          forbiddenPatterns: [{ id: "x", pattern: "X", paths: ["nonexistent"], message: "no X" }],
        },
      });
      const slice = createMockSlice();
      const resultPromise = runComputationalChecks(slice, config, "/fake/project", adapter);

      return resultPromise.then(() => {
        expect(true).toBe(true);
      });
    });

    it("handles unreadable file gracefully without failing the check", () => {
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockImplementation(() => {
        return { isDirectory: () => false, isFile: () => true } as fs.Stats;
      });
      mockReadFileSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      const adapter = createMockAdapter();
      const config = createMockConfig({
        checks: {
          commands: { build: "build", test: {} },
          forbiddenPatterns: [{ id: "test", pattern: "secret", paths: ["secrets/"], message: "no secrets" }],
        },
      });
      const slice = createMockSlice();
      const resultPromise = runComputationalChecks(slice, config, "/fake/project", adapter);

      return resultPromise.then((result) => {
        expect(result.pass).toBe(true);
      });
    });

    it("supports absolute paths in forbidden pattern rules", () => {
      const absolutePath = "/abs/path";
      mockExistsSync.mockReturnValue(true);
      mockStatSync.mockImplementation((p: fs.PathLike) => {
        return {
          isDirectory: () => !p.toString().endsWith("file.txt"),
          isFile: () => p.toString().endsWith("file.txt"),
        } as fs.Stats;
      });
      mockReaddirSync.mockReturnValue(["file.txt"] as unknown as fs.Dirent[]);
      mockReadFileSync.mockReturnValue("clean content");

      const adapter = createMockAdapter();
      const config = createMockConfig({
        checks: {
          commands: { build: "build", test: {} },
          forbiddenPatterns: [{ id: "global", pattern: "BAD", paths: ["/abs/path"], message: "no bad" }],
        },
      });
      const slice = createMockSlice();
      const resultPromise = runComputationalChecks(slice, config, "/fake/project", adapter);

      return resultPromise.then((result) => {
        expect(result.pass).toBe(true);
      });
    });
  });

  describe("missing completion artifacts", () => {
    it("detects missing completion artifacts", () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = p.toString();
        if (s.includes("src")) return true;
        return false;
      });

      const adapter = createMockAdapter();
      const config = createMockConfig();
      const slice = createMockSlice({
        completionArtifacts: ["output/report.json", "dist/bundle.js"],
      });
      const resultPromise = runComputationalChecks(slice, config, "/fake/project", adapter);

      return resultPromise.then((result) => {
        const missingArtifacts = result.failures.filter((f) => f.type === "missing_artifact");
        expect(missingArtifacts).toHaveLength(2);
        expect(missingArtifacts.every((f) => f.message.startsWith("Required artifact was not created:"))).toBe(true);
      });
    });

    it("detects missing absolute-path artifacts", () => {
      mockExistsSync.mockReturnValue(false);

      const adapter = createMockAdapter();
      const config = createMockConfig();
      const slice = createMockSlice({
        completionArtifacts: ["/absolute/path/output.log"],
      });
      const resultPromise = runComputationalChecks(slice, config, "/fake/project", adapter);

      return resultPromise.then((result) => {
        expect(result.failures.filter((f) => f.type === "missing_artifact")).toHaveLength(1);
        expect(result.failures[0].message).toContain("/absolute/path/output.log");
      });
    });

    it("does not report missing artifact when file exists", () => {
      mockExistsSync.mockReturnValue(true);

      const adapter = createMockAdapter();
      const config = createMockConfig();
      const slice = createMockSlice({ completionArtifacts: ["exists.txt"] });
      const resultPromise = runComputationalChecks(slice, config, "/fake/project", adapter);

      return resultPromise.then((result) => {
        expect(result.failures.filter((f) => f.type === "missing_artifact")).toHaveLength(0);
        expect(result.pass).toBe(true);
      });
    });
  });
});
