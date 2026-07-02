import * as fs from "fs";
import { logger } from "../utils/logger.js";

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
      return JSON.parse(data);
    } catch (err: any) {
      logger.warn(`Failed to parse state file at ${stateFilePath}: ${err.message}. Starting fresh.`);
    }
  }

  // Default clean state
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

export function saveState(stateFilePath: string, state: RunState): void {
  try {
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), "utf8");
    logger.debug(`Saved runner state to ${stateFilePath}`);
  } catch (err: any) {
    logger.error(`Failed to write state file to ${stateFilePath}: ${err.message}`);
  }
}

export function clearState(stateFilePath: string): void {
  if (fs.existsSync(stateFilePath)) {
    try {
      fs.unlinkSync(stateFilePath);
      logger.debug(`Cleared runner state file: ${stateFilePath}`);
    } catch (err: any) {
      logger.error(`Failed to clear state file: ${err.message}`);
    }
  }
}
