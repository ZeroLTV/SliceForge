import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  computeFileHash,
  computeTagFingerprint,
  isDrift,
  updateFingerprint,
} from "../../src/core/drift.js";

describe("drift detection", () => {
  let tempDir: string;
  let mockProjectRoot: string;
  let mockTestCasesDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-drift-test-"));
    mockProjectRoot = path.join(tempDir, "project");
    mockTestCasesDir = path.join(mockProjectRoot, "docs/test-cases");
    fs.mkdirSync(mockTestCasesDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe("computeFileHash", () => {
    it("should return empty if file does not exist", () => {
      const hash = computeFileHash(path.join(tempDir, "nonexistent.txt"));
      expect(hash).toBe("");
    });

    it("should return sha256 hash if file exists", () => {
      const helloPath = path.join(tempDir, "hello.txt");
      fs.writeFileSync(helloPath, "hello world", "utf8");
      const hash = computeFileHash(helloPath);
      // sha256 of "hello world"
      expect(hash).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
    });
  });

  describe("computeTagFingerprint", () => {
    it("should generate fingerprint based on files content in sorted order", () => {
      const doc1 = path.join(mockProjectRoot, "doc1.md");
      const doc2 = path.join(mockProjectRoot, "doc2.md");
      fs.writeFileSync(doc1, "content 1", "utf8");
      fs.writeFileSync(doc2, "content 2", "utf8");

      const fp1 = computeTagFingerprint("tag-1", ["doc1.md", "doc2.md"], mockProjectRoot);
      const fp2 = computeTagFingerprint("tag-1", ["doc2.md", "doc1.md"], mockProjectRoot);

      expect(fp1).toBe(fp2); // Must be deterministic and sorted
      expect(fp1).toHaveLength(64); // SHA-256 length
    });
  });

  describe("isDrift", () => {
    it("should return true if no saved map exists", () => {
      const drift = isDrift("tag-1", ["doc1.md"], mockProjectRoot, mockTestCasesDir);
      expect(drift).toBe(true);
    });

    it("should return true if test case file does not exist", () => {
      const docPath = path.join(mockProjectRoot, "doc1.md");
      fs.writeFileSync(docPath, "hello", "utf8");

      // Write testgen docs map, but not the tag-1.json artifact
      const mapContent = {
        "tag-1": {
          fingerprint: computeTagFingerprint("tag-1", ["doc1.md"], mockProjectRoot),
          docs: ["doc1.md"],
          timestamp: new Date().toISOString(),
        },
      };
      fs.writeFileSync(
        path.join(mockTestCasesDir, "testgen-docs-map.json"),
        JSON.stringify(mapContent),
        "utf8",
      );

      const drift = isDrift("tag-1", ["doc1.md"], mockProjectRoot, mockTestCasesDir);
      expect(drift).toBe(true);
    });

    it("should return false if fingerprint matches and file exists", () => {
      const docPath = path.join(mockProjectRoot, "doc1.md");
      fs.writeFileSync(docPath, "hello", "utf8");

      // Write both mapping and test cases JSON file
      const expectedFp = computeTagFingerprint("tag-1", ["doc1.md"], mockProjectRoot);
      const mapContent = {
        "tag-1": {
          fingerprint: expectedFp,
          docs: ["doc1.md"],
          timestamp: new Date().toISOString(),
        },
      };
      fs.writeFileSync(
        path.join(mockTestCasesDir, "testgen-docs-map.json"),
        JSON.stringify(mapContent),
        "utf8",
      );
      fs.writeFileSync(path.join(mockTestCasesDir, "tag-1.json"), "[]", "utf8");

      const drift = isDrift("tag-1", ["doc1.md"], mockProjectRoot, mockTestCasesDir);
      expect(drift).toBe(false);
    });
  });
});
