import * as fs from "fs";
import { parse as parseYaml } from "yaml";
import { createValidator, loadSchema } from "./schema-loader.js";
import type { SliceDefinition } from "./contracts.js";

const validator = createValidator(loadSchema("../schemas/testcases.schema.json"));

export function validateGeneratedTestCases(filePath: string, slice: SliceDefinition): void {
  if (!fs.existsSync(filePath))
    throw new Error(`Generated test-case artifact is missing: ${filePath}`);
  let value: unknown;
  try {
    value = parseYaml(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    throw new Error(
      `Generated test cases are invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!validator(value)) {
    const details = (validator.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Generated test cases failed schema validation: ${details}`);
  }
  const document = value as {
    sliceId: string;
    coverage: Array<{ acceptanceId: string }>;
  };
  if (document.sliceId !== slice.id) {
    throw new Error(`Generated test cases target '${document.sliceId}', expected '${slice.id}'.`);
  }
  const covered = new Set(document.coverage.map((item) => item.acceptanceId));
  const missing = slice.acceptance
    .map((criterion) => criterion.id)
    .filter((id) => !covered.has(id));
  if (missing.length)
    throw new Error(`Generated test cases do not cover acceptance: ${missing.join(", ")}`);
}
