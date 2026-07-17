import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { stringify as stringifyYaml } from "yaml";
import { validateGeneratedTestCases } from "../../src/core/testcase-validator";
import type { SliceDefinition } from "../../src/core/contracts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const slice: SliceDefinition = {
  id: "checkout",
  title: "Checkout",
  priority: 1,
  targets: ["app"],
  acceptance: [
    { id: "AC-1", expected: "valid card succeeds" },
    { id: "AC-2", expected: "invalid card fails" },
  ],
  allowedPaths: ["tests/**"],
};

function artifact(value: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-testcases-"));
  roots.push(root);
  const file = path.join(root, "testcases.yaml");
  fs.writeFileSync(file, stringifyYaml(value));
  return file;
}

describe("generated acceptance test validation", () => {
  it("accepts schema-valid coverage for every criterion", () => {
    const file = artifact({
      schemaVersion: 1,
      sliceId: "checkout",
      coverage: [
        { acceptanceId: "AC-1", scenarios: [{ name: "success", expected: "paid" }] },
        { acceptanceId: "AC-2", scenarios: [{ name: "failure", expected: "rejected" }] },
      ],
    });
    expect(() => validateGeneratedTestCases(file, slice)).not.toThrow();
  });

  it("rejects partial acceptance coverage", () => {
    const file = artifact({
      schemaVersion: 1,
      sliceId: "checkout",
      coverage: [{ acceptanceId: "AC-1", scenarios: [{ name: "success", expected: "paid" }] }],
    });
    expect(() => validateGeneratedTestCases(file, slice)).toThrow(/do not cover acceptance: AC-2/i);
  });

  it("rejects malformed YAML/schema documents", () => {
    const file = artifact({ schemaVersion: 1, sliceId: "checkout", coverage: [] });
    expect(() => validateGeneratedTestCases(file, slice)).toThrow(/schema validation/i);
  });
});
