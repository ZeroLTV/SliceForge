import { jest, describe, it, expect, beforeEach } from "@jest/globals";

jest.mock("fs", () => ({
  readFileSync: jest.fn(),
}));

jest.mock("url", () => ({
  fileURLToPath: jest.fn((u: unknown) => String(u)),
}));

import * as fs from "fs";
import { loadSchema, createValidator } from "../../src/utils/schema-loader.js";

const mockReadFileSync = fs.readFileSync as jest.Mock;

describe("schema-loader", () => {
  beforeEach(() => {
    mockReadFileSync.mockReset();
  });

  describe("loadSchema", () => {
    it("should successfully load and parse a valid JSON schema via __dirname resolution", () => {
      const schemaJson = JSON.stringify({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      });
      mockReadFileSync.mockReturnValue(schemaJson);

      const result = loadSchema("config.schema.json");

      expect(result).toEqual({
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      });
      expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    });

    it("should throw when neither __dirname nor import.meta.url resolution works", () => {
      mockReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      expect(() => loadSchema("nonexistent.json")).toThrow(
        "Failed to load schema: nonexistent.json. Neither CommonJS __dirname nor ESM import.meta.url resolution worked.",
      );
    });
  });

  describe("createValidator", () => {
    it("should return a function that validates data against the schema", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number", minimum: 0 },
        },
        required: ["name"],
      };
      const validate = createValidator(schema);

      expect(validate({ name: "Alice" })).toBe(true);
      expect(validate({ name: "Bob", age: 30 })).toBe(true);
      expect(validate({ name: 123 })).toBe(false);
      expect(validate({ age: 25 })).toBe(false);
      expect(validate({ name: "Eve", age: -1 })).toBe(false);
    });

    it("should collect all validation errors when allErrors is enabled", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "number" },
        },
        required: ["name", "age"],
      };
      const validate = createValidator(schema);

      const result = validate({});

      expect(result).toBe(false);
      expect(validate.errors).toBeDefined();
      expect(validate.errors!.length).toBeGreaterThanOrEqual(1);
    });
  });
});
