import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

jest.mock("dotenv", () => ({
  config: jest.fn(),
}));

jest.mock("../../src/utils/logger.js", () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    success: jest.fn(),
    section: jest.fn(),
    step: jest.fn(),
    setLogFile: jest.fn(),
  },
}));

describe("loadAndValidateSecrets", () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-secrets-test-"));
    originalEnv = { ...process.env };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.CURSOR_CLI_PATH;
    delete process.env.CLAUDE_CODE_PATH;
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    process.env = originalEnv;
  });

  const loadModule = async () => {
    const { loadAndValidateSecrets } = await import("../../src/utils/secrets.js");
    return loadAndValidateSecrets;
  };

  it("should load .env file if it exists", async () => {
    fs.writeFileSync(path.join(tempDir, ".env"), "DUMMY_VAR=hello", "utf8");
    const dotenv = await import("dotenv");
    const mockedConfig = dotenv.config as jest.MockedFunction<typeof dotenv.config>;

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const loadAndValidateSecrets = await loadModule();
    const result = loadAndValidateSecrets(tempDir, "api");

    expect(mockedConfig).toHaveBeenCalledWith({ path: path.join(tempDir, ".env") });
    expect(result).toHaveProperty("ANTHROPIC_API_KEY", "sk-ant-test");
    expect(result).toHaveProperty("OPENAI_API_KEY", "");
  });

  it("should warn if .env does not exist", async () => {
    const { logger } = await import("../../src/utils/logger.js");
    const mockedLogger = logger as jest.Mocked<typeof logger>;

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const loadAndValidateSecrets = await loadModule();
    loadAndValidateSecrets(tempDir, "api");

    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("No .env file found"),
    );
  });

  it("should throw error for api type when no ANTHROPIC_API_KEY or OPENAI_API_KEY", async () => {
    const loadAndValidateSecrets = await loadModule();

    expect(() => loadAndValidateSecrets(tempDir, "api")).toThrow(
      "Missing required environment variables for agent type 'api': ANTHROPIC_API_KEY or OPENAI_API_KEY",
    );
  });

  it("should return secrets for api type when ANTHROPIC_API_KEY exists", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const loadAndValidateSecrets = await loadModule();
    const result = loadAndValidateSecrets(tempDir, "api");

    expect(result).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      OPENAI_API_KEY: "",
    });
  });

  it("should return secrets for api type when only OPENAI_API_KEY exists", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test-key";
    const loadAndValidateSecrets = await loadModule();
    const result = loadAndValidateSecrets(tempDir, "api");

    expect(result).toEqual({
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "sk-openai-test-key",
    });
  });

  it("should return secrets for api type when both keys exist", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    process.env.OPENAI_API_KEY = "sk-openai-test-key";
    const loadAndValidateSecrets = await loadModule();
    const result = loadAndValidateSecrets(tempDir, "api");

    expect(result).toEqual({
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      OPENAI_API_KEY: "sk-openai-test-key",
    });
  });

  it("should handle cursor-cli type without errors (optional CURSOR_CLI_PATH)", async () => {
    const loadAndValidateSecrets = await loadModule();
    const result = loadAndValidateSecrets(tempDir, "cursor-cli");

    expect(result).toHaveProperty("CURSOR_CLI_PATH", "");
  });

  it("should handle cursor-cli type with CURSOR_CLI_PATH set", async () => {
    process.env.CURSOR_CLI_PATH = "/usr/local/bin/cursor";
    const loadAndValidateSecrets = await loadModule();
    const result = loadAndValidateSecrets(tempDir, "cursor-cli");

    expect(result).toEqual({
      CURSOR_CLI_PATH: "/usr/local/bin/cursor",
    });
  });

  it("should handle claude-code type without errors (optional CLAUDE_CODE_PATH)", async () => {
    const loadAndValidateSecrets = await loadModule();
    const result = loadAndValidateSecrets(tempDir, "claude-code");

    expect(result).toHaveProperty("CLAUDE_CODE_PATH", "");
  });

  it("should handle claude-code type with CLAUDE_CODE_PATH set", async () => {
    process.env.CLAUDE_CODE_PATH = "/usr/local/bin/claude";
    const loadAndValidateSecrets = await loadModule();
    const result = loadAndValidateSecrets(tempDir, "claude-code");

    expect(result).toEqual({
      CLAUDE_CODE_PATH: "/usr/local/bin/claude",
    });
  });

  it("should load .env file when present for cursor-cli type", async () => {
    fs.writeFileSync(path.join(tempDir, ".env"), "DUMMY_VAR=hello", "utf8");
    const dotenv = await import("dotenv");
    const mockedConfig = dotenv.config as jest.MockedFunction<typeof dotenv.config>;

    const loadAndValidateSecrets = await loadModule();
    loadAndValidateSecrets(tempDir, "cursor-cli");

    expect(mockedConfig).toHaveBeenCalledWith({ path: path.join(tempDir, ".env") });
  });
});
