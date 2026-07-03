import * as fs from "fs";
import { logger } from "../utils/logger.js";
import { StatePersistenceError } from "../utils/errors.js";

export interface RunState {
  currentSliceId: string;
  status: "running" | "pending_approval" | "completed";
  retriesPerSlice: Record<string, number>;
  gatesCompleted: ("checks" | "preview" | "browser" | "review")[];
  costAccumulated: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUSD?: number;
  };
  startedAt: string;
  updatedAt: string;
}

export function loadState(stateFilePath: string): RunState {
  if (fs.existsSync(stateFilePath)) {
    try {
      const data = fs.readFileSync(stateFilePath, "utf8");
      return JSON.parse(data) as RunState;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`Failed to parse state file at ${stateFilePath}: ${message}. Starting fresh.`);
    }
  }

  return createDefaultState();
}

export function saveState(stateFilePath: string, state: RunState): void {
  try {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new StatePersistenceError(
      `Failed to write state file to ${stateFilePath}: ${message}`,
      { stateFilePath },
    );
  }
}

export function clearState(stateFilePath: string): void {
  if (fs.existsSync(stateFilePath)) {
    try {
      fs.unlinkSync(stateFilePath);
      logger.debug(`Cleared runner state file: ${stateFilePath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new StatePersistenceError(
        `Failed to clear state file: ${message}`,
        { stateFilePath },
      );
    }
  }
}

function createDefaultState(): RunState {
  return {
    currentSliceId: "",
    status: "running",
    retriesPerSlice: {},
    gatesCompleted: [],
    costAccumulated: { inputTokens: 0, outputTokens: 0, estimatedCostUSD: 0 },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
