import { exec, execSync, spawn, type ChildProcess } from "child_process";
import { logger } from "./logger.js";

export interface ShellOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function killProcess(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /pid ${child.pid} /t /f`);
    } else {
      process.kill(child.pid, "SIGTERM");
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`Failed to kill process ${child.pid}: ${message}`);
  }
}

export function execCommand(
  command: string,
  options: ShellOptions = {},
): Promise<ShellResult> {
  const cwd = options.cwd || process.cwd();
  const env = { ...process.env, ...(options.env || {}) };
  const timeout = options.timeoutMs || 0;

  return new Promise((resolve) => {
    logger.debug(`Executing command: "${command}" in CWD: ${cwd}`);
    exec(command, { cwd, env, timeout }, (error, stdout, stderr) => {
      const exitCode = error
        ? typeof error.code === "number"
          ? error.code
          : 1
        : 0;
      resolve({
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        exitCode,
      });
    });
  });
}

export function spawnCommand(
  command: string,
  args: string[],
  options: ShellOptions = {},
): Promise<ShellResult> {
  const cwd = options.cwd || process.cwd();
  const env = { ...process.env, ...(options.env || {}) };
  const timeout = options.timeoutMs || 0;

  return new Promise((resolve) => {
    logger.debug(`Spawning command: "${command} ${args.join(" ")}" in CWD: ${cwd}`);
    const child = spawn(command, args, { cwd, env, shell: false });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      if (process.env.DEBUG) {
        process.stdout.write(chunk);
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      stderr += chunk;
      if (process.env.DEBUG) {
        process.stderr.write(chunk);
      }
    });

    let timeoutTimer: NodeJS.Timeout | null = null;
    if (timeout > 0) {
      timeoutTimer = setTimeout(() => {
        logger.error(`Spawned process timed out, killing: "${command}"`);
        child.kill();
      }, timeout);
    }

    child.on("close", (code: number | null) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      resolve({
        stdout,
        stderr,
        exitCode: code === null ? -1 : code,
      });
    });

    child.on("error", (err: Error) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      logger.error(
        `Failed to start command: "${command}". Error: ${err.message}`,
      );
      resolve({
        stdout,
        stderr: stderr + `\nError starting process: ${err.message}`,
        exitCode: -1,
      });
    });
  });
}
