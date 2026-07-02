import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { buildPrompt } from "../../src/core/prompt-builder.js";

describe("prompt builder", () => {
  let tempDir: string;
  let mockTemplatePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-prompt-test-"));
    mockTemplatePath = path.join(tempDir, "template.md");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should replace placeholders correctly", () => {
    fs.writeFileSync(mockTemplatePath, "Hello {{NAME}}! Welcome to {{PROJECT}}.", "utf8");

    const prompt = buildPrompt(mockTemplatePath, {
      NAME: "Alice",
      PROJECT: "SliceForge",
    });

    expect(prompt).toBe("Hello Alice! Welcome to SliceForge.");
  });

  it("should replace missing placeholders with empty strings", () => {
    fs.writeFileSync(mockTemplatePath, "Hello {{NAME}}! Your code is {{CODE}}.", "utf8");

    const prompt = buildPrompt(mockTemplatePath, {
      NAME: "Bob",
      // CODE is missing
    });

    expect(prompt).toBe("Hello Bob! Your code is .");
  });

  it("should replace multiple instances of the same placeholder", () => {
    fs.writeFileSync(mockTemplatePath, "{{NAME}} loves coding. {{NAME}} runs SliceForge.", "utf8");

    const prompt = buildPrompt(mockTemplatePath, {
      NAME: "Charlie",
    });

    expect(prompt).toBe("Charlie loves coding. Charlie runs SliceForge.");
  });
});
