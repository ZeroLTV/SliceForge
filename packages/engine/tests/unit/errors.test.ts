import { describe, it, expect } from "@jest/globals";
import {
  SliceForgeError,
  ConfigValidationError,
  BacklogValidationError,
  AgentExecutionError,
  GateCheckError,
  LockAcquisitionError,
  StatePersistenceError,
  ConfigurationNotFoundError,
} from "../../src/utils/errors.js";

describe("SliceForgeError base class", () => {
  it("should set .name, .message, .code, and .context properties", () => {
    const err = new SliceForgeError("something broke", "TEST_ERROR", { foo: "bar" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SliceForgeError");
    expect(err.message).toBe("something broke");
    expect(err.code).toBe("TEST_ERROR");
    expect(err.context).toEqual({ foo: "bar" });
  });

  it("should set .context to undefined when not provided", () => {
    const err = new SliceForgeError("no context", "NO_CTX");
    expect(err.context).toBeUndefined();
  });
});

describe("ConfigValidationError", () => {
  it("should have correct .name, .code, .message, and .context", () => {
    const err = new ConfigValidationError("invalid config", { field: "agent" });
    expect(err).toBeInstanceOf(SliceForgeError);
    expect(err.name).toBe("ConfigValidationError");
    expect(err.code).toBe("CONFIG_VALIDATION_FAILED");
    expect(err.message).toBe("invalid config");
    expect(err.context).toEqual({ field: "agent" });
  });

  it("should set .context to undefined when not provided", () => {
    const err = new ConfigValidationError("invalid config");
    expect(err.context).toBeUndefined();
  });
});

describe("BacklogValidationError", () => {
  it("should have correct .name, .code, .message, and .context", () => {
    const err = new BacklogValidationError("bad backlog", { sliceId: "s1" });
    expect(err).toBeInstanceOf(SliceForgeError);
    expect(err.name).toBe("BacklogValidationError");
    expect(err.code).toBe("BACKLOG_VALIDATION_FAILED");
    expect(err.message).toBe("bad backlog");
    expect(err.context).toEqual({ sliceId: "s1" });
  });
});

describe("AgentExecutionError", () => {
  it("should have correct .name, .code, .message, and .context", () => {
    const err = new AgentExecutionError("agent crashed", { exitCode: 1 });
    expect(err).toBeInstanceOf(SliceForgeError);
    expect(err.name).toBe("AgentExecutionError");
    expect(err.code).toBe("AGENT_EXECUTION_FAILED");
    expect(err.message).toBe("agent crashed");
    expect(err.context).toEqual({ exitCode: 1 });
  });
});

describe("GateCheckError", () => {
  it("should have correct .name, .code, .message, and .context", () => {
    const err = new GateCheckError("gate failed", { gate: "browser" });
    expect(err).toBeInstanceOf(SliceForgeError);
    expect(err.name).toBe("GateCheckError");
    expect(err.code).toBe("GATE_CHECK_FAILED");
    expect(err.message).toBe("gate failed");
    expect(err.context).toEqual({ gate: "browser" });
  });
});

describe("LockAcquisitionError", () => {
  it("should have correct .name, .code, .message, and .context", () => {
    const err = new LockAcquisitionError("lock busy", { pid: 1234 });
    expect(err).toBeInstanceOf(SliceForgeError);
    expect(err.name).toBe("LockAcquisitionError");
    expect(err.code).toBe("LOCK_ACQUISITION_FAILED");
    expect(err.message).toBe("lock busy");
    expect(err.context).toEqual({ pid: 1234 });
  });
});

describe("StatePersistenceError", () => {
  it("should have correct .name, .code, .message, and .context", () => {
    const err = new StatePersistenceError("write failed", { stateFilePath: "/tmp/state.json" });
    expect(err).toBeInstanceOf(SliceForgeError);
    expect(err.name).toBe("StatePersistenceError");
    expect(err.code).toBe("STATE_PERSISTENCE_FAILED");
    expect(err.message).toBe("write failed");
    expect(err.context).toEqual({ stateFilePath: "/tmp/state.json" });
  });
});

describe("ConfigurationNotFoundError", () => {
  it("should have correct .name, .code, .message, and .context with filePath", () => {
    const err = new ConfigurationNotFoundError("/some/config.json");
    expect(err).toBeInstanceOf(SliceForgeError);
    expect(err.name).toBe("ConfigurationNotFoundError");
    expect(err.code).toBe("CONFIG_NOT_FOUND");
    expect(err.message).toBe("Configuration file not found: /some/config.json");
    expect(err.context).toEqual({ filePath: "/some/config.json" });
  });
});
