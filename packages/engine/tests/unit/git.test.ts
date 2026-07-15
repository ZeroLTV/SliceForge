import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execCommand, spawnCommand } from "../../src/utils/shell.js";
import {
  hasUncommittedChanges,
  resetToLastCommit,
  resetToSha,
  commitSlice,
  getChangedFiles,
  getDiff,
} from "../../src/utils/git.js";

jest.mock("../../src/utils/shell.js", () => ({
  execCommand: jest.fn(),
  spawnCommand: jest.fn(),
}));

describe("git utils", () => {
  const mockCwd = "/mock/git/repo";
  const mockedExecCommand = execCommand as jest.MockedFunction<typeof execCommand>;
  const mockedSpawnCommand = spawnCommand as jest.MockedFunction<typeof spawnCommand>;

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
      expect(mockedExecCommand).toHaveBeenCalledWith("git status --porcelain", {
        cwd: mockCwd,
      });
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
      mockedSpawnCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await expect(resetToLastCommit(mockCwd)).resolves.not.toThrow();

      expect(mockedSpawnCommand).toHaveBeenNthCalledWith(
        1,
        "git",
        ["reset", "--hard", "HEAD"],
        { cwd: mockCwd },
      );
      expect(mockedSpawnCommand).toHaveBeenNthCalledWith(
        2,
        "git",
        ["clean", "-fd"],
        { cwd: mockCwd },
      );
    });

    it("should throw if git reset fails", async () => {
      mockedSpawnCommand.mockResolvedValueOnce({
        stdout: "",
        stderr: "error: unable to reset",
        exitCode: 1,
      });

      await expect(resetToLastCommit(mockCwd)).rejects.toThrow(
        "Failed to git reset",
      );
    });

    it("should exclude control files from clean when preservePaths provided", async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-git-"));
      const statePath = path.join(tmp, ".sliceforge-state.json");
      const lockPath = path.join(tmp, ".sliceforge.lock");
      const guardrailsPath = path.join(tmp, "docs", "guardrails.md");
      fs.mkdirSync(path.dirname(guardrailsPath), { recursive: true });
      fs.writeFileSync(statePath, "{}", "utf8");
      fs.writeFileSync(lockPath, "", "utf8");
      fs.writeFileSync(guardrailsPath, "", "utf8");

      mockedSpawnCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await expect(
        resetToLastCommit(tmp, [statePath, lockPath, guardrailsPath]),
      ).resolves.not.toThrow();

      expect(mockedSpawnCommand).toHaveBeenNthCalledWith(
        2,
        "git",
        [
          "clean",
          "-fd",
          "-e",
          path.relative(tmp, statePath).split(path.sep).join("/"),
          "-e",
          path.relative(tmp, lockPath).split(path.sep).join("/"),
          "-e",
          path.relative(tmp, guardrailsPath).split(path.sep).join("/"),
        ],
        { cwd: tmp },
      );

      fs.rmSync(tmp, { recursive: true, force: true });
    });
  });

  describe("resetToSha", () => {
    it("should reset to the given baseSha via spawn", async () => {
      mockedSpawnCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

      await expect(resetToSha(mockCwd, "abc1234")).resolves.not.toThrow();

      expect(mockedSpawnCommand).toHaveBeenNthCalledWith(
        1,
        "git",
        ["reset", "--hard", "abc1234"],
        { cwd: mockCwd },
      );
    });

    it("should throw when called without a baseSha", async () => {
      await expect(resetToSha(mockCwd, "")).rejects.toThrow(
        "resetToSha called without a baseSha",
      );
    });
  });

  describe("commitSlice", () => {
    it("should stage with excludes, then commit successfully", async () => {
      mockedSpawnCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      mockedExecCommand.mockResolvedValueOnce({
        stdout: "src/index.ts\n",
        stderr: "",
        exitCode: 0,
      });

      await expect(
        commitSlice(mockCwd, "slice-1", "feat: implement slice-1"),
      ).resolves.not.toThrow();

      const addCall = mockedSpawnCommand.mock.calls[0];
      expect(addCall[0]).toBe("git");
      expect(addCall[1][0]).toBe("add");
      expect(addCall[1]).toContain("-A");
      expect(addCall[1]).toContain(".");
      expect(addCall[1].some((a: string) => a.includes(":(exclude)**/.env*"))).toBe(
        true,
      );

      expect(mockedSpawnCommand).toHaveBeenLastCalledWith(
        "git",
        ["commit", "-m", "feat: implement slice-1"],
        { cwd: mockCwd },
      );
    });

    it("should refuse to commit protected files", async () => {
      mockedSpawnCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      mockedExecCommand.mockResolvedValueOnce({
        stdout: ".env.local\n",
        stderr: "",
        exitCode: 0,
      });

      await expect(
        commitSlice(mockCwd, "slice-1", "feat: implement slice-1"),
      ).rejects.toThrow("Refusing to commit protected files");

      const unstageCall = mockedSpawnCommand.mock.calls[1];
      expect(unstageCall[1]).toEqual(["reset", "--", "."]);
      expect(mockedSpawnCommand).not.toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "feat: implement slice-1"],
        { cwd: mockCwd },
      );
    });

    it("should skip commit when nothing staged", async () => {
      mockedSpawnCommand.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });
      mockedExecCommand.mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });

      await expect(
        commitSlice(mockCwd, "slice-1", "feat: implement slice-1"),
      ).resolves.not.toThrow();

      expect(mockedSpawnCommand).not.toHaveBeenCalledWith(
        "git",
        ["commit", "-m", "feat: implement slice-1"],
        { cwd: mockCwd },
      );
    });
  });

  describe("getChangedFiles", () => {
    it("should parse porcelain output and extract file names", async () => {
      mockedExecCommand.mockResolvedValueOnce({
        stdout: ' M src/index.ts\n?? "new file.ts"\n',
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
