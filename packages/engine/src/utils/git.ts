import * as fs from "fs";
import * as path from "path";
import { execCommand, spawnCommand } from "./shell.js";
import { logger } from "./logger.js";

export async function hasUncommittedChanges(cwd: string): Promise<boolean> {
  const result = await execCommand("git status --porcelain", { cwd });
  if (result.exitCode !== 0) {
    logger.error(`Git status check failed: ${result.stderr}`);
    return false;
  }
  return result.stdout.trim().length > 0;
}

export async function getCurrentSha(cwd: string): Promise<string> {
  const r = await execCommand("git rev-parse HEAD", { cwd });
  if (r.exitCode !== 0) throw new Error(`Failed to read HEAD sha: ${r.stderr}`);
  return r.stdout.trim();
}

interface ResetOpts {
  preservePaths?: string[];
}

async function applyReset(
  cwd: string,
  target: string,
  preservePaths: string[] = [],
): Promise<void> {
  const snapshots = preservePaths
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, c: fs.readFileSync(p, "utf8") }));

  const reset = await spawnCommand("git", ["reset", "--hard", target], { cwd });
  if (reset.exitCode !== 0) throw new Error(`Failed to git reset: ${reset.stderr}`);

  const cleanArgs = [
    "clean",
    "-fd",
    ...preservePaths.flatMap((p) => [
      "-e",
      path.relative(cwd, p).split(path.sep).join("/"),
    ]),
  ];
  const clean = await spawnCommand("git", cleanArgs, { cwd });
  if (clean.exitCode !== 0) logger.warn(`Git clean warning: ${clean.stderr}`);

  for (const s of snapshots) {
    fs.mkdirSync(path.dirname(s.p), { recursive: true });
    fs.writeFileSync(s.p, s.c, "utf8");
  }
}

export async function resetToLastCommit(
  cwd: string,
  preservePaths: string[] = [],
): Promise<void> {
  logger.warn(`Resetting uncommitted changes in ${cwd}...`);
  await applyReset(cwd, "HEAD", preservePaths);
  logger.success("Workspace reset to last commit successfully.");
}

export async function resetToSha(
  cwd: string,
  sha: string,
  opts: ResetOpts = {},
): Promise<void> {
  if (!sha) throw new Error("resetToSha called without a baseSha");
  logger.warn(
    `Resetting SliceForge-owned changes to ${sha} and cleaning untracked files (preserving control files).`,
  );
  await applyReset(cwd, sha, opts.preservePaths ?? []);
}

export async function stashChanges(
  cwd: string,
  message: string,
): Promise<boolean> {
  logger.warn(`Stashing uncommitted changes: ${message}`);
  const r = await spawnCommand("git", ["stash", "push", "-u", "-m", message], {
    cwd,
  });
  if (r.exitCode !== 0) throw new Error(`Failed to git stash: ${r.stderr}`);
  return !/No local changes to save/i.test(r.stdout);
}

const STAGE_EXCLUDES = [
  ":(exclude)**/.env*",
  ":(exclude)**/*.pem",
  ":(exclude)**/*.key",
  ":(exclude)**/*.pfx",
  ":(exclude)**/*.secret",
  ":(exclude)**/*.log",
  ":(exclude)node_modules",
  ":(exclude)**/.sliceforge*",
  ":(exclude)**/.sliceforge.lock",
];

const isForbiddenProtectedFile = (f: string): boolean =>
  /(^|[/\\])\.env(\..*)?$/i.test(f) ||
  /\.(pem|key|pfx|secret|log)$/i.test(f) ||
  /(^|[/\\])\.sliceforge/i.test(f) ||
  /(^|[/\\])node_modules([/\\]|$)/i.test(f);

export async function commitSlice(
  cwd: string,
  sliceId: string,
  message: string,
): Promise<void> {
  logger.info(`Staging changes for slice ${sliceId}...`);
  const add = await spawnCommand("git", ["add", "-A", "--", ".", ...STAGE_EXCLUDES], {
    cwd,
  });
  if (add.exitCode !== 0) throw new Error(`Failed to git add: ${add.stderr}`);

  const staged = await execCommand("git diff --cached --name-only", { cwd });
  if (staged.exitCode !== 0)
    throw new Error(`Failed to inspect staged files: ${staged.stderr}`);
  const files = staged.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const forbidden = files.filter(isForbiddenProtectedFile);
  if (forbidden.length > 0) {
    await spawnCommand("git", ["reset", "--", "."], { cwd });
    throw new Error(`Refusing to commit protected files: ${forbidden.join(", ")}`);
  }
  if (files.length === 0) {
    logger.warn(`Nothing staged to commit for slice ${sliceId}; skipping commit.`);
    return;
  }
  const commit = await spawnCommand("git", ["commit", "-m", message], { cwd });
  if (commit.exitCode !== 0) throw new Error(`Failed to git commit: ${commit.stderr}`);
  logger.success(`Committed changes for slice ${sliceId}.`);
}

export async function getChangedFiles(cwd: string): Promise<string[]> {
  const result = await execCommand("git status --porcelain", { cwd });
  if (result.exitCode !== 0) {
    return [];
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const parts = line.split(/\s+/);
      const name = parts.slice(1).join(" ");
      return name.replace(/^"(.*)"$/, "$1");
    });
}

export async function getDiff(
  cwd: string,
  maxBytes: number = 50000,
): Promise<string> {
  const result = await execCommand("git diff HEAD", { cwd });
  if (result.exitCode !== 0) {
    return "";
  }
  let diff = result.stdout;
  if (Buffer.byteLength(diff, "utf8") > maxBytes) {
    diff = diff.substring(0, maxBytes) + "\n\n...[Diff Truncated due to size]...";
  }
  return diff;
}
