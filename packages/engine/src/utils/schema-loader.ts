import * as fs from "fs";
import * as path from "path";
import type { ValidateFunction } from "ajv";

import AjvModule from "ajv";

type AjvConstructor = new (opts: { allErrors: boolean }) => { compile: (schema: unknown) => ValidateFunction };
const Ajv = (((AjvModule as unknown as { default?: AjvConstructor }).default ?? AjvModule) as unknown) as AjvConstructor;

function tryLoadViaDirname(schemaRelativePath: string): string | null {
  try {
    return fs.readFileSync(
      path.join(__dirname, schemaRelativePath),
      "utf8",
    );
  } catch {
    return null;
  }
}

function tryLoadViaImportMeta(schemaRelativePath: string): string | null {
  try {
    const { fileURLToPath } = require("url") as typeof import("url");
    const currentUrl = new Function("return import.meta.url")() as string;
    const schemaPath = fileURLToPath(new URL(schemaRelativePath, currentUrl));
    return fs.readFileSync(schemaPath, "utf8");
  } catch {
    return null;
  }
}

export function loadSchema(schemaRelativePath: string): Record<string, unknown> {
  const dirnameResult = tryLoadViaDirname(schemaRelativePath);
  if (dirnameResult) {
    return JSON.parse(dirnameResult);
  }

  const importMetaResult = tryLoadViaImportMeta(schemaRelativePath);
  if (importMetaResult) {
    return JSON.parse(importMetaResult);
  }

  throw new Error(
    `Failed to load schema: ${schemaRelativePath}. Neither CommonJS __dirname nor ESM import.meta.url resolution worked.`,
  );
}

export function createValidator(schema: Record<string, unknown>): ValidateFunction {
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(schema);
}
