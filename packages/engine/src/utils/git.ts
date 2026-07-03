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

export async function resetToLastCommit(cwd: string): Promise<void> {
  logger.warn(`Resetting uncommitted changes in ${cwd}...`);
  const resetResult = await execCommand("git reset --hard HEAD", { cwd });
  if (resetResult.exitCode !== 0) {
    throw new Error(`Failed to git reset: ${resetResult.stderr}`);
  }
  const cleanResult = await execCommand("git clean -fd", { cwd });
  if (cleanResult.exitCode !== 0) {
    logger.warn(`Git clean warning: ${cleanResult.stderr}`);
  }
  logger.success("Workspace reset to last commit successfully.");
}

export async function commitSlice(
  cwd: string,
  sliceId: string,
  message: string,
): Promise<void> {
  logger.info(`Adding changes to Git index for slice ${sliceId}...`);
  const addResult = await execCommand("git add -u .", { cwd });
  if (addResult.exitCode !== 0) {
    throw new Error(`Failed to git add: ${addResult.stderr}`);
  }

  const addNewResult = await execCommand("git add -A -- ':!:*.env' ':!*.log' ':!node_modules' ':!.sliceforge*'", { cwd });
  if (addNewResult.exitCode !== 0) {
    logger.warn(`Failed to stage new files, continuing with already tracked changes: ${addNewResult.stderr}`);
  }

  logger.info(`Committing changes: "${message}"`);
  const commitResult = await spawnCommand("git", ["commit", "-m", message], {
    cwd,
  });
  if (commitResult.exitCode !== 0) {
    throw new Error(`Failed to git commit: ${commitResult.stderr}`);
  }
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
