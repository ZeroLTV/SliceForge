import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import * as path from "path";

jest.mock("fs", () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

import * as fs from "fs";
import {
  resolveTemplatePath,
  ensureTemplateExists,
} from "../../src/utils/template-resolver.js";

const mockExistsSync = fs.existsSync as jest.Mock;
const mockMkdirSync = fs.mkdirSync as jest.Mock;
const mockWriteFileSync = fs.writeFileSync as jest.Mock;

const projectRoot = path.normalize("/fake/project");
const primaryDir = path.normalize("/fake/project/packages/engine/templates");
const fallbackDir = path.normalize("/fake/project/templates");

describe("template-resolver", () => {
  beforeEach(() => {
    mockExistsSync.mockReset();
    mockMkdirSync.mockReset();
    mockWriteFileSync.mockReset();
  });

  describe("resolveTemplatePath", () => {
    it("should return primary path when the primary template exists", () => {
      mockExistsSync.mockImplementation((p: string) => {
        return p.startsWith(primaryDir);
      });

      const result = resolveTemplatePath(projectRoot, "implementer");

      expect(result).toBe(path.join(primaryDir, "implementer.md"));
    });

    it("should fall back to templates/ when primary path does not exist", () => {
      mockExistsSync.mockImplementation((p: string) => {
        return !p.startsWith(primaryDir) && p.startsWith(fallbackDir);
      });

      const result = resolveTemplatePath(projectRoot, "implementer");

      expect(result).toBe(path.join(fallbackDir, "implementer.md"));
    });

    it("should create the fallback directory and return fallback path when neither path exists", () => {
      mockExistsSync.mockReturnValue(false);

      const result = resolveTemplatePath(projectRoot, "implementer");

      expect(result).toBe(path.join(fallbackDir, "implementer.md"));
      expect(mockMkdirSync).toHaveBeenCalledWith(fallbackDir, { recursive: true });
    });

    it("should resolve the implementer template path", () => {
      mockExistsSync.mockImplementation((p: string) => p.startsWith(primaryDir));

      const result = resolveTemplatePath(projectRoot, "implementer");

      expect(result).toBe(path.join(primaryDir, "implementer.md"));
    });

    it("should resolve the testgen template path", () => {
      mockExistsSync.mockImplementation((p: string) => p.startsWith(primaryDir));

      const result = resolveTemplatePath(projectRoot, "testgen");

      expect(result).toBe(path.join(primaryDir, "testgen.md"));
    });

    it("should resolve the tester template path", () => {
      mockExistsSync.mockImplementation((p: string) => p.startsWith(primaryDir));

      const result = resolveTemplatePath(projectRoot, "tester");

      expect(result).toBe(path.join(primaryDir, "tester.md"));
    });

    it("should resolve the reviewer template path", () => {
      mockExistsSync.mockImplementation((p: string) => p.startsWith(primaryDir));

      const result = resolveTemplatePath(projectRoot, "reviewer");

      expect(result).toBe(path.join(primaryDir, "reviewer.md"));
    });
  });

  describe("ensureTemplateExists", () => {
    const templatePath = path.join(fallbackDir, "custom.md");
    const defaultContent = "# Default Template\n\nPlaceholder content.";

    it("should create the template file and its directory when it does not exist", () => {
      mockExistsSync.mockReturnValue(false);

      ensureTemplateExists(templatePath, defaultContent);

      expect(mockExistsSync).toHaveBeenCalledWith(templatePath);
      expect(mockMkdirSync).toHaveBeenCalledWith(fallbackDir, { recursive: true });
      expect(mockWriteFileSync).toHaveBeenCalledWith(templatePath, defaultContent, "utf8");
    });

    it("should skip creation when the template file already exists", () => {
      mockExistsSync.mockImplementation((p: string) => p === templatePath);

      ensureTemplateExists(templatePath, defaultContent);

      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it("should create only the directory when template does not exist but dir does", () => {
      mockExistsSync.mockImplementation((p: string) => p === fallbackDir);

      ensureTemplateExists(templatePath, defaultContent);

      expect(mockMkdirSync).not.toHaveBeenCalled();
      expect(mockWriteFileSync).toHaveBeenCalledWith(templatePath, defaultContent, "utf8");
    });
  });
});
