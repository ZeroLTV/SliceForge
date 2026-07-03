import * as fs from "fs";
import { logger } from "./logger.js";
import { LockAcquisitionError } from "./errors.js";

class AlreadyRunningError extends Error {
  constructor(pid: number) {
    super(`Another SliceForge instance is already running (PID: ${pid})`);
    this.name = "AlreadyRunningError";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    throw err;
  }
}

function tryWriteLockFile(lockFilePath: string): void {
  try {
    fs.writeFileSync(lockFilePath, `${process.pid}`, "utf8");
    logger.debug(`Acquired lock: ${lockFilePath} (PID: ${process.pid})`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new LockAcquisitionError(`Failed to create lock file: ${message}`, {
      lockFilePath,
    });
  }
}

export function acquireLock(lockFilePath: string): void {
  if (fs.existsSync(lockFilePath)) {
    let content: string;
    try {
      content = fs.readFileSync(lockFilePath, "utf8").trim();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new LockAcquisitionError(
        `Failed to read lock file: ${message}`,
        { lockFilePath },
      );
    }

    const pid = parseInt(content, 10);
    if (!isNaN(pid) && isProcessAlive(pid)) {
      throw new AlreadyRunningError(pid);
    }

    logger.warn(
      `Stale lock file found (PID ${isNaN(pid) ? "unknown" : pid} process is dead). Cleaning up lock: ${lockFilePath}`,
    );
  }

  tryWriteLockFile(lockFilePath);
}

export function releaseLock(lockFilePath: string): void {
  if (fs.existsSync(lockFilePath)) {
    try {
      fs.unlinkSync(lockFilePath);
      logger.debug(`Released lock: ${lockFilePath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new LockAcquisitionError(
        `Failed to release lock file: ${message}`,
        { lockFilePath },
      );
    }
  }
}
