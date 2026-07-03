import * as fs from "fs";
import * as path from "path";
import type { ValidateFunction } from "ajv";
import { logger } from "../utils/logger.js";
import { ConfigValidationError, ConfigurationNotFoundError } from "../utils/errors.js";
import { loadSchema, createValidator } from "../utils/schema-loader.js";

const schema = loadSchema("../schemas/config.schema.json");
const validateFn: ValidateFunction = createValidator(schema);

export interface SliceForgeConfig {
  project: string;
  agent: {
    type: "cursor-cli" | "claude-code" | "api";
    model?: string;
    timeoutMs?: number;
  };
  stack: {
    type: "node" | "dotnet" | "custom";
    api?: { port: number; healthPath: string };
    web?: { port: number; healthPath: string };
    db?: { compose: string; service: string };
  };
  checks: {
    commands: {
      build: string;
      lint?: string;
      test: { unit?: string; integration?: string; e2e?: string };
    };
    forbiddenPatterns?: Array<{
      id: string;
      pattern: string;
      paths: string[];
      message: string;
    }>;
  };
  loop: {
    maxIterations: number;
    maxRetriesPerSlice: number;
    requireHumanApproval?: string[];
    browserTest: {
      required: boolean;
      requirePreviewStack: boolean;
    };
    testCaseGate: "required" | "warn" | "skip";
  };
  paths: {
    backlog: string;
    testCases: string;
    guardrails: string;
    state: string;
    lock: string;
  };
}

interface RawConfig {
  project?: unknown;
  agent?: unknown;
  stack?: unknown;
  checks?: unknown;
  loop?: unknown;
  paths?: Record<string, unknown>;
}

export function loadConfig(projectRoot: string): SliceForgeConfig {
  const configPath = path.join(projectRoot, "sliceforge.config.json");
  if (!fs.existsSync(configPath)) {
    throw new ConfigurationNotFoundError(configPath);
  }

  let rawConfig: RawConfig;
  try {
    const rawData = fs.readFileSync(configPath, "utf8");
    rawConfig = JSON.parse(rawData) as RawConfig;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(`Failed to parse sliceforge.config.json: ${message}`, { configPath });
  }

  if (!rawConfig.paths) {
    rawConfig.paths = {};
  }
  rawConfig.paths = {
    backlog: "whole-app-backlog.json",
    testCases: "docs/test-cases/items",
    guardrails: "docs/guardrails.md",
    state: ".sliceforge-state.json",
    lock: ".sliceforge.lock",
    ...rawConfig.paths,
  };

  const valid = validateFn(rawConfig);
  if (!valid) {
    const errors = validateFn.errors
      ? validateFn.errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join(", ")
      : "Unknown validation error";
    const errorMsg = `Configuration validation failed: ${errors}`;
    logger.error(errorMsg);
    throw new ConfigValidationError(errorMsg, { errors: validateFn.errors });
  }

  return rawConfig as unknown as SliceForgeConfig;
}
