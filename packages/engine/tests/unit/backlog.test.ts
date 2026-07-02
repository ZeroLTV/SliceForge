import { jest, describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  loadBacklog,
  saveBacklog,
  pickNextSlice,
  markSliceDone,
  allSlicesPass,
} from "../../src/core/backlog.js";

describe("backlog manager", () => {
  let tempDir: string;
  let backlogPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-backlog-test-"));
    backlogPath = path.join(tempDir, "backlog.json");
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const sampleBacklog = {
    slices: [
      { id: "slice-1", passes: true, priority: 1, description: "First slice" },
      { id: "slice-2", passes: false, priority: 2, description: "Second slice" },
      { id: "slice-3", passes: false, priority: 1, description: "Third slice (lower priority, run first)" },
    ],
  };

  describe("loadBacklog", () => {
    it("should parse and validate backlog correctly", () => {
      fs.writeFileSync(backlogPath, JSON.stringify(sampleBacklog), "utf8");

      const backlog = loadBacklog(backlogPath);
      expect(backlog.slices).toHaveLength(3);
      expect(backlog.slices[0].id).toBe("slice-1");
    });
  });

  describe("pickNextSlice", () => {
    it("should pick pending slice with lowest priority", () => {
      const nextSlice = pickNextSlice(sampleBacklog);
      expect(nextSlice).not.toBeNull();
      expect(nextSlice!.id).toBe("slice-3"); // passes: false, priority: 1 vs priority: 2
    });

    it("should return null if all slices are completed", () => {
      const completedBacklog = {
        slices: [
          { id: "slice-1", passes: true, priority: 1, description: "Done" },
          { id: "slice-2", passes: true, priority: 2, description: "Done" },
        ],
      };
      const nextSlice = pickNextSlice(completedBacklog);
      expect(nextSlice).toBeNull();
    });
  });

  describe("markSliceDone", () => {
    it("should set passes to true for matching slice id", () => {
      const backlogCopy = JSON.parse(JSON.stringify(sampleBacklog));
      markSliceDone(backlogCopy, "slice-2");
      expect(backlogCopy.slices[1].passes).toBe(true);
    });

    it("should throw if slice id does not exist", () => {
      expect(() => markSliceDone(sampleBacklog, "non-existent")).toThrow("Slice not found in backlog");
    });
  });

  describe("allSlicesPass", () => {
    it("should return false if any slice is pending", () => {
      expect(allSlicesPass(sampleBacklog)).toBe(false);
    });

    it("should return true if all slices are completed", () => {
      const completedBacklog = {
        slices: [
          { id: "slice-1", passes: true, priority: 1, description: "Done" },
        ],
      };
      expect(allSlicesPass(completedBacklog)).toBe(true);
    });
  });
});
