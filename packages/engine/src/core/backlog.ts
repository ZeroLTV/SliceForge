import * as fs from "fs";
import type { ValidateFunction } from "ajv";
import { logger } from "../utils/logger.js";
import { BacklogValidationError } from "../utils/errors.js";
import { loadSchema, createValidator } from "../utils/schema-loader.js";

const schema = loadSchema("../schemas/backlog.schema.json");
const validateFn: ValidateFunction = createValidator(schema);

export interface Slice {
  id: string;
  passes: boolean;
  priority: number;
  phase?: number;
  agent?: string;
  acceptance?: string[];
  docs?: string[];
  completionArtifacts?: string[];
  testRequirements?: {
    unit?: string[];
    integration?: string[];
    e2e?: string[];
    acceptanceTags?: string[];
  };
  description: string;
  tags?: string[];
}

export interface Backlog {
  branchName?: string;
  slices: Slice[];
}

export function loadBacklog(backlogPath: string): Backlog {
  if (!fs.existsSync(backlogPath)) {
    throw new BacklogValidationError(`Backlog file not found: ${backlogPath}`, { backlogPath });
  }

  let backlog: unknown;
  try {
    const rawData = fs.readFileSync(backlogPath, "utf8");
    backlog = JSON.parse(rawData);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BacklogValidationError(`Failed to parse backlog JSON: ${message}`, { backlogPath });
  }

  const valid = validateFn(backlog);
  if (!valid) {
    const errors = validateFn.errors
      ? validateFn.errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join(", ")
      : "Unknown validation error";
    const errorMsg = `Backlog validation failed: ${errors}`;
    logger.error(errorMsg);
    throw new BacklogValidationError(errorMsg, { errors: validateFn.errors });
  }

  return backlog as Backlog;
}

export function saveBacklog(backlogPath: string, backlog: Backlog): void {
  try {
    const data = JSON.stringify(backlog, null, 2);
    fs.writeFileSync(backlogPath, data, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new BacklogValidationError(`Failed to save backlog JSON: ${message}`, { backlogPath });
  }
}

export function pickNextSlice(backlog: Backlog): Slice | null {
  const pendingSlices = backlog.slices.filter((s) => !s.passes);
  if (pendingSlices.length === 0) {
    return null;
  }

  return pendingSlices.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    const phaseA = a.phase ?? 0;
    const phaseB = b.phase ?? 0;
    return phaseA - phaseB;
  })[0];
}

export function markSliceDone(backlog: Backlog, sliceId: string): void {
  const slice = backlog.slices.find((s) => s.id === sliceId);
  if (!slice) {
    throw new Error(`Slice not found in backlog: ${sliceId}`);
  }
  slice.passes = true;
}

export function allSlicesPass(backlog: Backlog): boolean {
  return backlog.slices.every((s) => s.passes);
}

export function getSlice(backlog: Backlog, sliceId: string): Slice | null {
  return backlog.slices.find((s) => s.id === sliceId) || null;
}
