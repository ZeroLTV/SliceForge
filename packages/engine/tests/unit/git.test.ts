import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { execCommand, spawnCommand } from "../../src/utils/shell.js";
import {
  hasUncommittedChanges,
  resetToLastCommit,
  commitSlice,
  getChangedFiles,
  getDiff,
} from "../../src/utils/git.js";

// Mock shell execution to keep tests isolated and fast
jest.mock("../../src/utils/shell.js", () => ({
  execCommand: jest.fn(),
  spawnCommand: jest.fn(),
}));

describe("git utils", () => {
  const mockCwd = "/mock/git/repo";
  const mockedExecCommand = execCommand as jest.MockedFunction<typeof execCommand>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("hasUncommittedChanges", () => {
    it("should return true when porcelain output has entries", async () => {
      mockedExecCommand.mockResolvedValueOnce({
        stdout: " M src/index.ts\n?? newfile.ts\n",
        stderr: "",
        exitCode: 0,
      });

      const result = await hasUncommittedChanges(mockCwd);
      expect(result).toBe(true);
      expect(mockedExecCommand).toHaveBeenCalledWith("git status --porcelain", { cwd: mockCwd });
    });

    it("should return false when porcelain output is empty", async () => {
      mockedExecCommand.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      const result = await hasUncommittedChanges(mockCwd);
      expect(result).toBe(false);
    });

    it("should return false and log error on git command failure", async () => {
      mockedExecCommand.mockResolvedValueOnce({
        stdout: "",
        stderr: "fatal: not a git repository",
        exitCode: 128,
      });

      const result = await hasUncommittedChanges(mockCwd);
      expect(result).toBe(false);
    });
  });

  describe("resetToLastCommit", () => {
    it("should call git reset and clean on resetToLastCommit", async () => {
      mockedExecCommand
        .mockResolvedValueOnce({ stdout: "HEAD is now at 1234567", stderr: "", exitCode: 0 }) // reset
        .mockResolvedValueOnce({ stdout: "Removing untrackedfile.ts", stderr: "", exitCode: 0 }); // clean

      await expect(resetToLastCommit(mockCwd)).resolves.not.toThrow();

      expect(mockedExecCommand).toHaveBeenNthCalledWith(1, "git reset --hard HEAD", { cwd: mockCwd });
      expect(mockedExecCommand).toHaveBeenNthCalledWith(2, "git clean -fd", { cwd: mockCwd });
    });

    it("should throw if git reset fails", async () => {
      mockedExecCommand.mockResolvedValueOnce({
        stdout: "",
        stderr: "error: unable to reset",
        exitCode: 1,
      });

      await expect(resetToLastCommit(mockCwd)).rejects.toThrow("Failed to git reset");
    });
  });

  describe("commitSlice", () => {
    it("should add and commit changes successfully", async () => {
      const mockedSpawnCommand = spawnCommand as jest.MockedFunction<typeof spawnCommand>;
      mockedExecCommand.mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 0 }); // git add
      mockedSpawnCommand.mockResolvedValueOnce({ stdout: "1 file changed", stderr: "", exitCode: 0 }); // git commit

      await expect(commitSlice(mockCwd, "slice-1", "feat: implement slice-1")).resolves.not.toThrow();

      expect(mockedExecCommand).toHaveBeenNthCalledWith(1, "git add .", { cwd: mockCwd });
      expect(mockedSpawnCommand).toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "feat: implement slice-1"],
        { cwd: mockCwd },
      );
    });
  });

  describe("getChangedFiles", () => {
    it("should parse porcelain output and extract file names", async () => {
      mockedExecCommand.mockResolvedValueOnce({
        stdout: " M src/index.ts\n?? \"new file.ts\"\n",
        stderr: "",
        exitCode: 0,
      });

      const files = await getChangedFiles(mockCwd);
      expect(files).toEqual(["src/index.ts", "new file.ts"]);
    });
  });

  describe("getDiff", () => {
    it("should return diff output and truncate if too large", async () => {
      const longDiff = "a".repeat(100);
      mockedExecCommand.mockResolvedValueOnce({
        stdout: longDiff,
        stderr: "",
        exitCode: 0,
      });

      const result = await getDiff(mockCwd, 50);
      expect(result).toContain("...[Diff Truncated due to size]...");
    });
  });
});
