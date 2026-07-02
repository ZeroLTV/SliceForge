import * as fs from "fs";
import Ajv from "ajv";

import * as path from "path";
import { fileURLToPath } from "url";
import { logger } from "../utils/logger.js";

let backlogSchema: any;
try {
  // CommonJS fallback (like Jest testing)
  backlogSchema = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../schemas/backlog.schema.json"), "utf8")
  );
} catch (_err) {
  // ESM Production mode
  const currentUrl = new Function("return import.meta.url")();
  const schemaPath = fileURLToPath(new URL("../schemas/backlog.schema.json", currentUrl));
  backlogSchema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

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

const ajv = new (Ajv as any)({ allErrors: true });
const validateFn = ajv.compile(backlogSchema);

export function loadBacklog(backlogPath: string): Backlog {
  if (!fs.existsSync(backlogPath)) {
    throw new Error(`Backlog file not found: ${backlogPath}`);
  }

  let backlog: any;
  try {
    const rawData = fs.readFileSync(backlogPath, "utf8");
    backlog = JSON.parse(rawData);
  } catch (err: any) {
    throw new Error(`Failed to parse backlog JSON: ${err.message}`);
  }

  const valid = validateFn(backlog);
  if (!valid) {
    const errors = validateFn.errors
      ? validateFn.errors.map((e: any) => `${e.instancePath} ${e.message}`).join(", ")
      : "Unknown validation error";
    const errorMsg = `Backlog validation failed: ${errors}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  return backlog as Backlog;
}

export function saveBacklog(backlogPath: string, backlog: Backlog): void {
  try {
    const data = JSON.stringify(backlog, null, 2);
    fs.writeFileSync(backlogPath, data, "utf8");
  } catch (err: any) {
    throw new Error(`Failed to save backlog JSON: ${err.message}`);
  }
}

export function pickNextSlice(backlog: Backlog): Slice | null {
  const pendingSlices = backlog.slices.filter((s) => !s.passes);
  if (pendingSlices.length === 0) {
    return null;
  }

  // Sort by priority first (ascending), then phase if present
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
