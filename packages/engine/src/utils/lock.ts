import * as fs from "fs";
import { logger } from "./logger.js";

export function acquireLock(lockFilePath: string): void {
  if (fs.existsSync(lockFilePath)) {
    let stale = true;
    try {
      const content = fs.readFileSync(lockFilePath, "utf8").trim();
      const pid = parseInt(content, 10);
      if (!isNaN(pid)) {
        // process.kill(pid, 0) checks if process is running without killing it
        process.kill(pid, 0);
        stale = false;
        throw new Error(`Another SliceForge instance is already running (PID: ${pid})`);
      }
    } catch (err: any) {
      if (err.code === "ESRCH") {
        // Process is not running, so lock is stale
        logger.warn(`Stale lock file found (PID process is dead). Cleaning up lock: ${lockFilePath}`);
      } else {
        // Re-throw if it's the "already running" error
        throw err;
      }
    }
  }

  // Write current PID to lock file
  try {
    fs.writeFileSync(lockFilePath, `${process.pid}`, "utf8");
    logger.debug(`Acquired lock: ${lockFilePath} (PID: ${process.pid})`);
  } catch (err: any) {
    throw new Error(`Failed to create lock file: ${err.message}`);
  }
}

export function releaseLock(lockFilePath: string): void {
  if (fs.existsSync(lockFilePath)) {
    try {
      fs.unlinkSync(lockFilePath);
      logger.debug(`Released lock: ${lockFilePath}`);
    } catch (err: any) {
      logger.error(`Failed to release lock file: ${err.message}`);
    }
  }
}
