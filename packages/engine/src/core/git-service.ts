import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { CommandSpec } from "./contracts.js";
import { runProcess } from "./process-runner.js";

export interface ChangedPath {
  status: string;
  path: string;
  originalPath?: string;
}

function git(args: string[], timeoutMs = 120000): CommandSpec {
  return { command: "git", args, timeoutMs };
}

function assertSuccess(result: { exitCode: number; stderr: string }, action: string): void {
  if (result.exitCode !== 0) throw new Error(`${action}: ${result.stderr}`);
}

export class GitService {
  constructor(readonly projectRoot: string) {}

  async assertRepository(): Promise<void> {
    const result = await runProcess(git(["rev-parse", "--is-inside-work-tree"]), {
      root: this.projectRoot,
    });
    if (result.exitCode !== 0 || result.stdout.trim() !== "true") {
      throw new Error(`Not a Git working tree: ${this.projectRoot}`);
    }
  }

  async commonDir(): Promise<string> {
    const result = await runProcess(git(["rev-parse", "--git-common-dir"]), {
      root: this.projectRoot,
    });
    assertSuccess(result, "Failed to resolve Git common directory");
    return result.stdout.trim();
  }

  async head(cwd = this.projectRoot): Promise<string> {
    const result = await runProcess(git(["rev-parse", "HEAD"]), { root: cwd });
    assertSuccess(result, "Failed to resolve HEAD");
    return result.stdout.trim();
  }

  async branch(cwd = this.projectRoot): Promise<string> {
    const result = await runProcess(git(["branch", "--show-current"]), { root: cwd });
    assertSuccess(result, "Failed to resolve current branch");
    const branch = result.stdout.trim();
    if (!branch) throw new Error("Detached HEAD is not supported for this operation.");
    return branch;
  }

  async status(cwd = this.projectRoot): Promise<ChangedPath[]> {
    const result = await runProcess(
      git(["status", "--porcelain=v2", "-z", "--untracked-files=all"]),
      { root: cwd, maxOutputBytes: 4 * 1024 * 1024 },
    );
    assertSuccess(result, "Failed to inspect Git status");
    const entries = result.stdout.split("\0").filter(Boolean);
    const changed: ChangedPath[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (entry.startsWith("? ")) {
        changed.push({ status: "?", path: entry.slice(2) });
      } else if (entry.startsWith("1 ")) {
        const parts = entry.split(" ");
        changed.push({ status: parts[1], path: parts.slice(8).join(" ") });
      } else if (entry.startsWith("2 ")) {
        const parts = entry.split(" ");
        changed.push({
          status: parts[1],
          path: parts.slice(9).join(" "),
          originalPath: entries[++index],
        });
      } else if (entry.startsWith("u ")) {
        const parts = entry.split(" ");
        changed.push({ status: parts[1], path: parts.slice(10).join(" ") });
      }
    }
    return changed;
  }

  async isClean(cwd = this.projectRoot): Promise<boolean> {
    return (await this.status(cwd)).length === 0;
  }

  async createWorktree(worktreePath: string, branchName: string, baseSha: string): Promise<void> {
    if (fs.existsSync(worktreePath)) {
      throw new Error(`Worktree path already exists: ${worktreePath}`);
    }
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const result = await runProcess(
      git(["worktree", "add", "--no-track", "-b", branchName, worktreePath, baseSha]),
      { root: this.projectRoot, maxOutputBytes: 1024 * 1024 },
    );
    assertSuccess(result, "Failed to create isolated worktree");
  }

  async createDetachedWorktree(worktreePath: string, commitSha: string): Promise<void> {
    if (fs.existsSync(worktreePath)) {
      throw new Error(`Validation worktree path already exists: ${worktreePath}`);
    }
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const result = await runProcess(git(["worktree", "add", "--detach", worktreePath, commitSha]), {
      root: this.projectRoot,
      maxOutputBytes: 1024 * 1024,
    });
    assertSuccess(result, "Failed to create detached validation worktree");
  }

  async removeWorktree(worktreePath: string, force = false): Promise<void> {
    if (!fs.existsSync(worktreePath)) return;
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktreePath);
    const result = await runProcess(git(args), { root: this.projectRoot });
    assertSuccess(result, "Failed to remove worktree");
  }

  async restoreWorktree(worktreePath: string, branchName: string, baseSha: string): Promise<void> {
    if (fs.existsSync(worktreePath)) {
      const valid = await runProcess(git(["rev-parse", "--is-inside-work-tree"]), {
        root: worktreePath,
      });
      if (valid.exitCode === 0 && valid.stdout.trim() === "true") return;
      throw new Error(`Recovery path exists but is not a valid Git worktree: ${worktreePath}`);
    }
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    const prune = await runProcess(git(["worktree", "prune"]), { root: this.projectRoot });
    assertSuccess(prune, "Failed to prune stale worktree metadata");
    const branch = await runProcess(
      git(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]),
      {
        root: this.projectRoot,
      },
    );
    const args =
      branch.exitCode === 0
        ? ["worktree", "add", worktreePath, branchName]
        : ["worktree", "add", "--no-track", "-b", branchName, worktreePath, baseSha];
    const result = await runProcess(git(args), {
      root: this.projectRoot,
    });
    assertSuccess(result, "Failed to restore isolated worktree");
  }

  async resetWorktree(cwd: string, baseSha: string): Promise<void> {
    const reset = await runProcess(git(["reset", "--hard", baseSha]), { root: cwd });
    assertSuccess(reset, "Failed to reset isolated worktree");
    const clean = await runProcess(git(["clean", "-fd"]), { root: cwd });
    assertSuccess(clean, "Failed to clean isolated worktree");
  }

  async changedSince(baseSha: string, cwd: string): Promise<string[]> {
    const result = await runProcess(git(["diff", "--name-only", "-z", baseSha, "--"]), {
      root: cwd,
      maxOutputBytes: 4 * 1024 * 1024,
    });
    assertSuccess(result, "Failed to inspect changed files");
    const tracked = result.stdout.split("\0").filter(Boolean);
    const untracked = (await this.status(cwd))
      .filter((entry) => entry.status === "?")
      .map((entry) => entry.path);
    return [...new Set([...tracked, ...untracked])].sort();
  }

  async diff(baseSha: string, cwd: string, maxBytes = 512 * 1024): Promise<string> {
    const result = await runProcess(git(["diff", "--binary", baseSha, "--"]), {
      root: cwd,
      maxOutputBytes: maxBytes,
    });
    assertSuccess(result, "Failed to generate diff");
    let output = result.stdout;
    const untracked = (await this.status(cwd)).filter((entry) => entry.status === "?");
    for (const entry of untracked) {
      const absolutePath = path.resolve(cwd, entry.path);
      const relative = path.relative(cwd, absolutePath);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Untracked path escapes worktree: ${entry.path}`);
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      const header = `diff --git a/${entry.path} b/${entry.path}\nnew file mode ${stat.isSymbolicLink() ? "120000" : "100644"}\n--- /dev/null\n+++ b/${entry.path}\n`;
      const remaining =
        maxBytes - Buffer.byteLength(output, "utf8") - Buffer.byteLength(header, "utf8");
      if (remaining <= 0) break;
      let body: string;
      if (stat.isSymbolicLink()) {
        body = `@@ -0,0 +1 @@\n+${fs.readlinkSync(absolutePath)}\n`;
      } else if (stat.size > remaining) {
        body = `[SliceForge omitted untracked file larger than remaining diff limit: ${stat.size} bytes]\n`;
      } else {
        const content = fs.readFileSync(absolutePath);
        if (content.includes(0)) {
          body = `Binary files /dev/null and b/${entry.path} differ\n`;
        } else {
          const text = content.toString("utf8");
          const lines = text.split(/\r?\n/);
          if (lines.at(-1) === "") lines.pop();
          body = `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
        }
      }
      const addition = `${header}${body}`;
      if (Buffer.byteLength(addition, "utf8") > remaining + Buffer.byteLength(header, "utf8")) {
        output += `${header}[SliceForge truncated untracked diff]\n`;
        break;
      }
      output += addition;
    }
    if (Buffer.byteLength(output, "utf8") <= maxBytes) return output;
    return `${Buffer.from(output, "utf8").subarray(0, maxBytes).toString("utf8")}\n...[diff truncated by SliceForge]...`;
  }

  async fingerprint(baseSha: string, cwd: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    for (const relativePath of await this.changedSince(baseSha, cwd)) {
      const absolutePath = path.resolve(cwd, relativePath);
      const relative = path.relative(cwd, absolutePath);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Changed path escapes worktree: ${relativePath}`);
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        hash.update(`\0${relativePath}\0deleted\0`);
        continue;
      }
      hash.update(`\0${relativePath}\0${stat.mode}\0${stat.size}\0`);
      if (stat.isSymbolicLink()) hash.update(fs.readlinkSync(absolutePath));
      else if (stat.isFile()) hash.update(fs.readFileSync(absolutePath));
    }
    return hash.digest("hex");
  }

  async commit(cwd: string, message: string): Promise<string> {
    const add = await runProcess(git(["add", "-A", "--", "."]), { root: cwd });
    assertSuccess(add, "Failed to stage worktree changes");
    const commit = await runProcess(git(["commit", "-m", message]), { root: cwd });
    assertSuccess(commit, "Failed to commit verified slice");
    return this.head(cwd);
  }

  async createCommitFromTree(treeSha: string, parentSha: string, message: string): Promise<string> {
    const result = await runProcess(git(["commit-tree", treeSha, "-p", parentSha, "-m", message]), {
      root: this.projectRoot,
    });
    assertSuccess(result, "Failed to create task bundle commit");
    const commitSha = result.stdout.trim();
    if (!/^[a-f0-9]{40,64}$/i.test(commitSha)) {
      throw new Error("Git returned an invalid task bundle commit id.");
    }
    return commitSha;
  }

  async assertArtifactsTracked(cwd: string, artifacts: string[]): Promise<void> {
    for (const artifact of artifacts) {
      const ignored = await runProcess(git(["check-ignore", "--quiet", "--", artifact]), {
        root: cwd,
      });
      if (ignored.exitCode === 0) {
        throw new Error(`Required artifact is ignored and cannot be verified: ${artifact}`);
      }
      if (ignored.exitCode !== 1) {
        throw new Error(
          `Failed to inspect ignore policy for artifact '${artifact}': ${ignored.stderr}`,
        );
      }
      const tracked = await runProcess(git(["ls-files", "--error-unmatch", "--", artifact]), {
        root: cwd,
      });
      if (tracked.exitCode !== 0) {
        throw new Error(`Required artifact is not present in the candidate commit: ${artifact}`);
      }
    }
  }

  async rebase(cwd: string, ontoSha: string): Promise<void> {
    const result = await runProcess(git(["rebase", ontoSha]), { root: cwd });
    if (result.exitCode !== 0) {
      const abort = await runProcess(git(["rebase", "--abort"]), { root: cwd });
      if (abort.exitCode !== 0) {
        throw new Error(
          `Failed to rebase isolated worktree: ${result.stderr}. Rebase rollback also failed: ${abort.stderr}`,
        );
      }
      throw new Error(
        `Failed to rebase isolated worktree; worktree was rolled back: ${result.stderr}`,
      );
    }
  }

  async cherryPick(commitSha: string): Promise<void> {
    const result = await runProcess(git(["cherry-pick", commitSha]), { root: this.projectRoot });
    if (result.exitCode !== 0) {
      const abort = await runProcess(git(["cherry-pick", "--abort"]), { root: this.projectRoot });
      if (abort.exitCode !== 0) {
        throw new Error(
          `Failed to promote verified slice: ${result.stderr}. Cherry-pick rollback also failed: ${abort.stderr}`,
        );
      }
      throw new Error(
        `Failed to promote verified slice; original tree was rolled back: ${result.stderr}`,
      );
    }
  }

  async rollbackOriginal(baseSha: string): Promise<void> {
    const reset = await runProcess(git(["reset", "--hard", baseSha]), { root: this.projectRoot });
    assertSuccess(reset, "Failed to roll back original branch after promotion validation");
    const clean = await runProcess(git(["clean", "-fd"]), { root: this.projectRoot });
    assertSuccess(clean, "Failed to clean original branch after promotion validation");
  }

  async tree(ref = "HEAD", cwd = this.projectRoot): Promise<string> {
    const result = await runProcess(git(["rev-parse", `${ref}^{tree}`]), { root: cwd });
    assertSuccess(result, `Failed to resolve tree for ${ref}`);
    return result.stdout.trim();
  }

  async firstParent(ref = "HEAD", cwd = this.projectRoot): Promise<string | undefined> {
    const result = await runProcess(git(["rev-parse", `${ref}^`]), { root: cwd });
    if (result.exitCode === 0) return result.stdout.trim();
    if (/unknown revision|ambiguous argument|bad revision/i.test(result.stderr)) return undefined;
    throw new Error(`Failed to resolve first parent for ${ref}: ${result.stderr}`);
  }

  async isAncestor(commitSha: string, descendant = "HEAD"): Promise<boolean> {
    const result = await runProcess(git(["merge-base", "--is-ancestor", commitSha, descendant]), {
      root: this.projectRoot,
    });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`Failed to verify commit ancestry: ${result.stderr}`);
  }

  async abortCherryPick(cwd = this.projectRoot): Promise<void> {
    const gitDir = await runProcess(git(["rev-parse", "--git-dir"]), { root: cwd });
    assertSuccess(gitDir, "Failed to inspect cherry-pick recovery state");
    const cherryPickHead = path.resolve(cwd, gitDir.stdout.trim(), "CHERRY_PICK_HEAD");
    if (!fs.existsSync(cherryPickHead)) return;
    const abort = await runProcess(git(["cherry-pick", "--abort"]), { root: cwd });
    assertSuccess(abort, "Failed to abort interrupted cherry-pick");
  }

  async deleteBranch(branchName: string): Promise<void> {
    const result = await runProcess(git(["branch", "-D", branchName]), { root: this.projectRoot });
    assertSuccess(result, "Failed to delete SliceForge branch");
  }
}
