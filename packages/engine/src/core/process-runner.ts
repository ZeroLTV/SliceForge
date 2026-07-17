import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import execa from "execa";
import type { CommandSpec } from "./contracts.js";
import { redactText } from "./redaction.js";

export interface ProcessRunOptions {
  root: string;
  stdin?: string;
  secrets?: string[];
  maxOutputBytes?: number;
  cancellationFile?: string;
  environment?: Record<string, string>;
}

export interface ProcessRunResult {
  exitCode: number;
  failedToStart: boolean;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  sensitiveOutputDetected: boolean;
}

const EXECUTION_ENV_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
];

function resolveCwd(root: string, configured?: string): string {
  const cwd = path.resolve(root, configured ?? ".");
  const relative = path.relative(root, cwd);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Command cwd escapes the worktree: ${configured}`);
  }
  try {
    const realRoot = fs.realpathSync.native(root);
    const realCwd = fs.realpathSync.native(cwd);
    const realRelative = path.relative(realRoot, realCwd);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    ) {
      throw new Error(`Command cwd resolves through a symlink outside the worktree: ${configured}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes("resolves through a symlink")) throw err;
    // Execa reports a missing/inaccessible cwd consistently with other spawn failures.
  }
  return cwd;
}

function regularLocalFile(cwd: string, name: string): string | undefined {
  const candidate = path.join(cwd, name);
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function resolvePortableWrapper(command: string, cwd: string): string {
  if (process.platform === "win32") {
    if (command === "./gradlew") return regularLocalFile(cwd, "gradlew.bat") ?? command;
    if (command === "./mvnw") return regularLocalFile(cwd, "mvnw.cmd") ?? command;
  } else {
    if (command === "gradlew.bat") return regularLocalFile(cwd, "gradlew") ?? command;
    if (command === "mvnw.cmd") return regularLocalFile(cwd, "mvnw") ?? command;
  }
  return command;
}

function isCommandNotFound(stderr: string): boolean {
  return /is not recognized as an internal or external command|command not found/i.test(stderr);
}

interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

async function terminateProcessTree(subprocess: KillableProcess): Promise<void> {
  if (!subprocess.pid) {
    subprocess.kill("SIGKILL");
    return;
  }
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      execFile(
        "taskkill.exe",
        ["/pid", String(subprocess.pid), "/t", "/f"],
        { windowsHide: true },
        () => resolve(),
      );
    });
    return;
  }
  try {
    process.kill(-subprocess.pid, "SIGTERM");
  } catch {
    subprocess.kill("SIGTERM");
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try {
    process.kill(-subprocess.pid, 0);
    process.kill(-subprocess.pid, "SIGKILL");
  } catch {
    // The process group exited after SIGTERM.
  }
}

export async function runProcess(
  spec: CommandSpec,
  options: ProcessRunOptions,
): Promise<ProcessRunResult> {
  const startedAt = Date.now();
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  const executionEnv: Record<string, string> = {};
  for (const key of EXECUTION_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) executionEnv[key] = value;
  }
  const inherited: Record<string, string> = {};
  for (const key of spec.envAllowlist ?? []) {
    const value = process.env[key];
    if (value !== undefined) inherited[key] = value;
  }
  const secrets = [
    ...(options.secrets ?? []),
    ...Object.values(spec.env ?? {}),
    ...Object.values(inherited),
  ];
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTruncated = false;
  let stderrTruncated = false;
  const capture = (chunks: Buffer[], stream: "stdout" | "stderr", chunk: Buffer): void => {
    const used = stream === "stdout" ? stdoutBytes : stderrBytes;
    const remaining = Math.max(0, maxOutputBytes - used);
    if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
    if (stream === "stdout") {
      stdoutBytes += Math.min(chunk.length, remaining);
      stdoutTruncated ||= chunk.length > remaining;
    } else {
      stderrBytes += Math.min(chunk.length, remaining);
      stderrTruncated ||= chunk.length > remaining;
    }
  };
  const captured = (chunks: Buffer[], wasTruncated: boolean): string => {
    const value = Buffer.concat(chunks).toString("utf8");
    return wasTruncated ? `${value}\n...[output truncated by SliceForge]...` : value;
  };
  const containsSensitiveOutput = (stdout: string, stderr: string): boolean =>
    (options.secrets ?? [])
      .filter((secret) => secret.length >= 4)
      .some((secret) => stdout.includes(secret) || stderr.includes(secret));

  try {
    const cwd = resolveCwd(options.root, spec.cwd);
    const subprocess = execa(resolvePortableWrapper(spec.command, cwd), spec.args ?? [], {
      cwd,
      env: { ...executionEnv, ...inherited, ...(spec.env ?? {}), ...(options.environment ?? {}) },
      extendEnv: false,
      input: options.stdin,
      reject: false,
      shell: spec.shell ?? false,
      buffer: false,
      detached: process.platform !== "win32",
    });
    subprocess.stdout?.on("data", (chunk: Buffer) => capture(stdoutChunks, "stdout", chunk));
    subprocess.stderr?.on("data", (chunk: Buffer) => capture(stderrChunks, "stderr", chunk));
    let cancelled = false;
    let timedOut = false;
    let termination: Promise<void> | undefined;
    const terminate = (reason: "cancel" | "timeout"): void => {
      if (reason === "cancel") cancelled = true;
      else timedOut = true;
      termination ??= terminateProcessTree(subprocess);
    };
    const cancellationTimer = options.cancellationFile
      ? setInterval(() => {
          if (fs.existsSync(options.cancellationFile!)) {
            terminate("cancel");
          }
        }, 200)
      : undefined;
    const timeoutTimer = spec.timeoutMs
      ? setTimeout(() => terminate("timeout"), spec.timeoutMs)
      : undefined;
    const result = await subprocess.finally(() => {
      if (cancellationTimer) clearInterval(cancellationTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
    });
    if (termination) await termination;
    const rawStdout = captured(stdoutChunks, stdoutTruncated);
    const rawStderr = captured(stderrChunks, stderrTruncated);
    const sensitiveOutputDetected = containsSensitiveOutput(rawStdout, rawStderr);
    const stdout = redactText(rawStdout, secrets);
    const stderr = redactText(rawStderr, secrets);
    return {
      exitCode: result.exitCode ?? 1,
      failedToStart: isCommandNotFound(stderr),
      stdout,
      stderr,
      timedOut,
      cancelled,
      durationMs: Date.now() - startedAt,
      sensitiveOutputDetected,
    };
  } catch (err) {
    const error = err as Error & {
      code?: string;
      exitCode?: number;
      stdout?: string;
      stderr?: string;
      timedOut?: boolean;
      isCanceled?: boolean;
    };
    const rawStdout = captured(stdoutChunks, stdoutTruncated) || error.stdout || "";
    const rawStderr = captured(stderrChunks, stderrTruncated) || error.stderr || error.message;
    return {
      exitCode: error.exitCode ?? -1,
      failedToStart: error.code === "ENOENT" || error.code === "EACCES",
      stdout: redactText(rawStdout, secrets),
      stderr: redactText(rawStderr, secrets),
      timedOut: error.timedOut ?? false,
      cancelled:
        error.isCanceled ??
        Boolean(options.cancellationFile && fs.existsSync(options.cancellationFile)),
      durationMs: Date.now() - startedAt,
      sensitiveOutputDetected: containsSensitiveOutput(rawStdout, rawStderr),
    };
  }
}
