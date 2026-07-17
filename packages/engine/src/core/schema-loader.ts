import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import type { ValidateFunction } from "ajv";

import AjvModule from "ajv";

type AjvConstructor = new (opts: { allErrors: boolean }) => {
  addSchema: (schema: unknown, key?: string) => void;
  compile: (schema: unknown) => ValidateFunction;
};
const Ajv = ((AjvModule as unknown as { default?: AjvConstructor }).default ??
  AjvModule) as unknown as AjvConstructor;

function getSchemaDirectories(): string[] {
  const directories: string[] = [];

  if (typeof __dirname !== "undefined") {
    directories.push(__dirname);
  }

  if (process.argv[1]) {
    directories.push(path.dirname(process.argv[1]));
  }

  try {
    const requireFromCwd = createRequire(path.join(process.cwd(), "sliceforge-resolver.js"));
    const packageRoot = path.dirname(requireFromCwd.resolve("@zeroltv/sliceforge/package.json"));
    directories.push(path.join(packageRoot, "dist", "core"), path.join(packageRoot, "src", "core"));
  } catch {
    // The CLI entrypoint and CommonJS paths still cover global and test usage.
  }

  return [...new Set(directories)];
}

export function loadSchema(schemaRelativePath: string): Record<string, unknown> {
  for (const directory of getSchemaDirectories()) {
    const schemaPath = path.resolve(directory, schemaRelativePath);
    try {
      const raw = fs.readFileSync(schemaPath, "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Try the next runtime layout.
    }
  }

  throw new Error(
    `Failed to load schema: ${schemaRelativePath}. Neither CommonJS __dirname nor ESM package resolution worked.`,
  );
}

export function createValidator(
  schema: Record<string, unknown>,
  dependencies: Array<{ key: string; schema: Record<string, unknown> }> = [],
): ValidateFunction {
  const ajv = new Ajv({ allErrors: true });
  for (const dependency of dependencies) ajv.addSchema(dependency.schema, dependency.key);
  return ajv.compile(schema);
}
