export { loadConfig } from "./core/config.js";
export type { SliceForgeConfig } from "./core/config.js";
export {
  loadBacklog,
  saveBacklog,
  pickNextSlice,
  markSliceDone,
  allSlicesPass,
  getSlice,
} from "./core/backlog.js";
export type { Slice, Backlog } from "./core/backlog.js";
export { runRalphLoop, approveSlice } from "./core/ralph-runner.js";
export { runTestGenLoop } from "./core/testgen-runner.js";
export {
  type AgentAdapter,
  type AgentResult,
  type AgentRunOptions,
  AgentSignal,
  parseAgentSignal,
} from "./agents/base-agent.js";
export type { StackAdapter } from "./adapters/base-adapter.js";
export { logger } from "./utils/logger.js";
export { LogLevel } from "./utils/logger.js";
export { execCommand, spawnCommand } from "./utils/shell.js";
export type { ShellResult, ShellOptions } from "./utils/shell.js";
export { SliceForgeError, ConfigValidationError, BacklogValidationError, AgentExecutionError, GateCheckError, LockAcquisitionError, StatePersistenceError } from "./utils/errors.js";
export { resolveTemplatePath, ensureTemplateExists } from "./utils/template-resolver.js";
