import * as fs from "fs";
import * as path from "path";
import Ajv from "ajv";
import { logger } from "../utils/logger.js";

import { fileURLToPath } from "url";

let schemaJson: any;
try {
  // CommonJS fallback (like Jest testing)
  schemaJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../schemas/config.schema.json"), "utf8")
  );
} catch (_err) {
  // ESM Production mode
  const currentUrl = new Function("return import.meta.url")();
  const schemaPath = fileURLToPath(new URL("../schemas/config.schema.json", currentUrl));
  schemaJson = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}

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

const ajv = new (Ajv as any)({ allErrors: true });
const validateFn = ajv.compile(schemaJson);

export function loadConfig(projectRoot: string): SliceForgeConfig {
  const configPath = path.join(projectRoot, "sliceforge.config.json");
  if (!fs.existsSync(configPath)) {
    throw new Error(`Configuration file not found: ${configPath}`);
  }

  let rawConfig: any;
  try {
    const rawData = fs.readFileSync(configPath, "utf8");
    rawConfig = JSON.parse(rawData);
  } catch (err: any) {
    throw new Error(`Failed to parse sliceforge.config.json: ${err.message}`);
  }

  // Populate default paths if not present
  if (!rawConfig.paths) {
    rawConfig.paths = {};
  }
  rawConfig.paths = {
    backlog: rawConfig.paths.backlog || "whole-app-backlog.json",
    testCases: rawConfig.paths.testCases || "docs/test-cases/items",
    guardrails: rawConfig.paths.guardrails || "docs/guardrails.md",
    state: rawConfig.paths.state || ".sliceforge-state.json",
    lock: rawConfig.paths.lock || ".sliceforge.lock",
    ...rawConfig.paths,
  };

  const valid = validateFn(rawConfig);
  if (!valid) {
    const errors = validateFn.errors
      ? validateFn.errors.map((e: any) => `${e.instancePath} ${e.message}`).join(", ")
      : "Unknown validation error";
    const errorMsg = `Configuration validation failed: ${errors}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  return rawConfig as SliceForgeConfig;
}
