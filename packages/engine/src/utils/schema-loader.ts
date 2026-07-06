import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import type { ValidateFunction } from "ajv";

import AjvModule from "ajv";

type AjvConstructor = new (opts: { allErrors: boolean }) => { compile: (schema: unknown) => ValidateFunction };
const Ajv = (((AjvModule as unknown as { default?: AjvConstructor }).default ?? AjvModule) as unknown) as AjvConstructor;

function getSchemaDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return __dirname;
  }
}

export function loadSchema(schemaRelativePath: string): Record<string, unknown> {
  const dir = getSchemaDir();
  const schemaPath = path.join(dir, schemaRelativePath);

  try {
    const raw = fs.readFileSync(schemaPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load schema at ${schemaPath}: ${message}`,
    );
  }
}

export function createValidator(schema: Record<string, unknown>): ValidateFunction {
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(schema);
}
