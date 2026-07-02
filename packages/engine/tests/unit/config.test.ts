import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { loadConfig } from "../../src/core/config.js";

describe("config loader", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-config-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should successfully load and validate a correct config", () => {
    const validConfig = {
      project: "test-app",
      agent: {
        type: "api",
        model: "claude-3-5-sonnet",
      },
      stack: {
        type: "node",
      },
      checks: {
        commands: {
          build: "npm run build",
          test: {
            unit: "npm run test:unit",
          },
        },
      },
      loop: {
        maxIterations: 10,
        maxRetriesPerSlice: 3,
        browserTest: {
          required: false,
          requirePreviewStack: false,
        },
        testCaseGate: "skip",
      },
    };
    
    fs.writeFileSync(path.join(tempDir, "sliceforge.config.json"), JSON.stringify(validConfig), "utf8");

    const config = loadConfig(tempDir);

    expect(config.project).toBe("test-app");
    expect(config.agent.type).toBe("api");
    expect(config.paths.backlog).toBe("whole-app-backlog.json"); // Default populated
    expect(config.paths.lock).toBe(".sliceforge.lock"); // Default populated
  });

  it("should throw error if config file does not exist", () => {
    expect(() => loadConfig(tempDir)).toThrow("Configuration file not found");
  });

  it("should throw error if config JSON is invalid", () => {
    fs.writeFileSync(path.join(tempDir, "sliceforge.config.json"), "{ invalid-json }", "utf8");

    expect(() => loadConfig(tempDir)).toThrow("Failed to parse sliceforge.config.json");
  });

  it("should throw error if required field is missing", () => {
    const invalidConfig = {
      project: "test-app",
      // missing agent
      stack: { type: "node" },
    };
    fs.writeFileSync(path.join(tempDir, "sliceforge.config.json"), JSON.stringify(invalidConfig), "utf8");

    expect(() => loadConfig(tempDir)).toThrow("Configuration validation failed");
  });
});
