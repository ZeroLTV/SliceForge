import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("fs", () => {
  const actualFs = jest.requireActual("fs") as typeof fs;
  return {
    __esModule: true,
    ...actualFs,
  };
});

import { loadState, saveState, clearState } from "../../src/core/state.js";
import { StatePersistenceError } from "../../src/utils/errors.js";

const mockFs = fs as typeof fs;

describe("loadState", () => {
  let tempDir: string;
  let stateFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-state-test-"));
    stateFilePath = path.join(tempDir, "state.json");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return default state when file does not exist", () => {
    const state = loadState(stateFilePath);

    expect(state.currentSliceId).toBe("");
    expect(state.status).toBe("running");
    expect(state.retriesPerSlice).toEqual({});
    expect(state.gatesCompleted).toEqual([]);
    expect(state.costAccumulated).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUSD: 0,
    });
    expect(state.startedAt).toBeTruthy();
    expect(state.updatedAt).toBeTruthy();
    expect(new Date(state.startedAt).toString()).not.toBe("Invalid Date");
    expect(new Date(state.updatedAt).toString()).not.toBe("Invalid Date");
  });

  it("should load existing state from file", () => {
    const existingState = {
      currentSliceId: "slice-1",
      status: "pending_approval",
      retriesPerSlice: { "slice-1": 2 },
      gatesCompleted: ["checks", "preview"],
      costAccumulated: {
        inputTokens: 5000,
        outputTokens: 2000,
        estimatedCostUSD: 0.05,
      },
      startedAt: "2025-01-01T00:00:00.000Z",
      updatedAt: "2025-01-01T01:00:00.000Z",
    };
    fs.writeFileSync(stateFilePath, JSON.stringify(existingState), "utf8");

    const state = loadState(stateFilePath);

    expect(state.currentSliceId).toBe("slice-1");
    expect(state.status).toBe("pending_approval");
    expect(state.retriesPerSlice).toEqual({ "slice-1": 2 });
    expect(state.gatesCompleted).toEqual(["checks", "preview"]);
    expect(state.costAccumulated).toEqual({
      inputTokens: 5000,
      outputTokens: 2000,
      estimatedCostUSD: 0.05,
    });
    expect(state.startedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(state.updatedAt).toBe("2025-01-01T01:00:00.000Z");
  });

  it("should fall back to default state on parse error", () => {
    fs.writeFileSync(stateFilePath, "{ invalid json content !!! }", "utf8");

    const state = loadState(stateFilePath);

    expect(state.currentSliceId).toBe("");
    expect(state.status).toBe("running");
  });
});

describe("saveState", () => {
  let tempDir: string;
  let stateFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-save-test-"));
    stateFilePath = path.join(tempDir, "state.json");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should write state file and update updatedAt", () => {
    const state = {
      currentSliceId: "slice-2",
      status: "running" as const,
      retriesPerSlice: {},
      gatesCompleted: ["checks" as const],
      costAccumulated: {
        inputTokens: 100,
        outputTokens: 50,
        estimatedCostUSD: 0.01,
      },
      startedAt: "2025-06-01T00:00:00.000Z",
      updatedAt: "2025-06-01T00:00:00.000Z",
    };

    const beforeSave = new Date();
    saveState(stateFilePath, state);
    const afterSave = new Date();

    expect(fs.existsSync(stateFilePath)).toBe(true);
    const saved = JSON.parse(fs.readFileSync(stateFilePath, "utf8"));
    expect(saved.currentSliceId).toBe("slice-2");
    expect(saved.status).toBe("running");
    expect(saved.gatesCompleted).toEqual(["checks"]);
    expect(saved.costAccumulated).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUSD: 0.01,
    });
    expect(saved.startedAt).toBe("2025-06-01T00:00:00.000Z");

    const updatedAt = new Date(saved.updatedAt);
    expect(updatedAt.getTime()).toBeGreaterThanOrEqual(beforeSave.getTime());
    expect(updatedAt.getTime()).toBeLessThanOrEqual(afterSave.getTime());
  });

  it("should throw StatePersistenceError on write failure", () => {
    const actualWriteFileSync = mockFs.writeFileSync;
    mockFs.writeFileSync = (() => {
      throw new Error("disk full");
    }) as typeof fs.writeFileSync;

    try {
      const state = {
        currentSliceId: "slice-3",
        status: "running" as const,
        retriesPerSlice: {},
        gatesCompleted: [],
        costAccumulated: { inputTokens: 0, outputTokens: 0, estimatedCostUSD: 0 },
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      expect(() => saveState(stateFilePath, state)).toThrow(StatePersistenceError);
      expect(() => saveState(stateFilePath, state)).toThrow("Failed to write state file");
    } finally {
      mockFs.writeFileSync = actualWriteFileSync;
    }
  });
});

describe("clearState", () => {
  let tempDir: string;
  let stateFilePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-clear-test-"));
    stateFilePath = path.join(tempDir, "state.json");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should remove the state file when it exists", () => {
    fs.writeFileSync(stateFilePath, "{}", "utf8");
    expect(fs.existsSync(stateFilePath)).toBe(true);

    clearState(stateFilePath);

    expect(fs.existsSync(stateFilePath)).toBe(false);
  });

  it("should not throw when the state file does not exist", () => {
    expect(() => clearState(stateFilePath)).not.toThrow();
  });

  it("should throw StatePersistenceError on removal failure", () => {
    fs.writeFileSync(stateFilePath, "{}", "utf8");

    const actualUnlinkSync = mockFs.unlinkSync;
    mockFs.unlinkSync = (() => {
      throw new Error("permission denied");
    }) as typeof fs.unlinkSync;

    try {
      expect(() => clearState(stateFilePath)).toThrow(StatePersistenceError);
      expect(() => clearState(stateFilePath)).toThrow("Failed to clear state file");
    } finally {
      mockFs.unlinkSync = actualUnlinkSync;
    }
  });
});
