export class SliceForgeError extends Error {
  public readonly code: string;
  public readonly context?: Record<string, unknown>;

  constructor(message: string, code: string, context?: Record<string, unknown>) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
  }
}

export class ConfigValidationError extends SliceForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "CONFIG_VALIDATION_FAILED", context);
  }
}

export class BacklogValidationError extends SliceForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "BACKLOG_VALIDATION_FAILED", context);
  }
}

export class AgentExecutionError extends SliceForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "AGENT_EXECUTION_FAILED", context);
  }
}

export class GateCheckError extends SliceForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "GATE_CHECK_FAILED", context);
  }
}

export class LockAcquisitionError extends SliceForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "LOCK_ACQUISITION_FAILED", context);
  }
}

export class StatePersistenceError extends SliceForgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "STATE_PERSISTENCE_FAILED", context);
  }
}

export class ConfigurationNotFoundError extends SliceForgeError {
  constructor(filePath: string) {
    super(`Configuration file not found: ${filePath}`, "CONFIG_NOT_FOUND", { filePath });
  }
}
