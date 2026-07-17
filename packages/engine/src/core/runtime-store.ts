import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import lockfile from "proper-lockfile";
import type { RunEvent, RunRecord, RunStatus } from "./contracts.js";

const TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  planned: new Set(["preparing", "failed", "cancelled"]),
  preparing: new Set(["implementing", "validating", "failed", "cancelled"]),
  implementing: new Set(["validating", "preparing", "failed", "blocked", "cancelled"]),
  validating: new Set([
    "reviewing",
    "ready_to_promote",
    "needs_attention",
    "preparing",
    "failed",
    "blocked",
    "cancelled",
  ]),
  reviewing: new Set([
    "ready_to_promote",
    "needs_attention",
    "preparing",
    "failed",
    "blocked",
    "cancelled",
  ]),
  needs_attention: new Set(["promoting", "validating", "blocked", "cancelled"]),
  ready_to_promote: new Set(["promoting", "validating", "blocked", "cancelled"]),
  promoting: new Set(["promoted", "failed", "blocked"]),
  promoted: new Set(["promoted"]),
  failed: new Set(["preparing", "cancelled"]),
  blocked: new Set(["preparing", "validating", "cancelled"]),
  cancelled: new Set(),
};

function assertSafeRunId(runId: string): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error(`Invalid run id: ${runId}`);
}

export interface RuntimePaths {
  root: string;
  runs: string;
  tasks: string;
  evaluations: string;
  reports: string;
  worktrees: string;
}

export interface ProjectLockOptions {
  retries?: number;
  minTimeoutMs?: number;
  maxTimeoutMs?: number;
}

export function createRunId(sliceId: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  return `${stamp}-${sliceId.replace(/[^a-zA-Z0-9._-]/g, "-")}-${crypto.randomBytes(4).toString("hex")}`;
}

export function getRuntimePaths(projectRoot: string, gitCommonDir: string): RuntimePaths {
  const repoKey = crypto
    .createHash("sha256")
    .update(path.resolve(projectRoot))
    .digest("hex")
    .slice(0, 16);
  const root = path.join(path.resolve(projectRoot, gitCommonDir), "sliceforge");
  return {
    root,
    runs: path.join(root, "runs"),
    tasks: path.join(root, "tasks"),
    evaluations: path.join(root, "evaluations"),
    reports: path.join(root, "reports"),
    worktrees: path.join(os.tmpdir(), "sliceforge-worktrees", repoKey),
  };
}

export function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  const fd = fs.openSync(tempPath, "wx", 0o600);
  try {
    fs.writeFileSync(fd, content, "utf8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tempPath, filePath);
  if (process.platform !== "win32") {
    const directoryFd = fs.openSync(path.dirname(filePath), "r");
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
  }
}

function writeAll(fd: number, content: string): void {
  const buffer = Buffer.from(content, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) throw new Error("Failed to append a complete event journal record.");
    offset += written;
  }
}

function repairPartialTail(eventPath: string): void {
  if (!fs.existsSync(eventPath)) return;
  const content = fs.readFileSync(eventPath);
  if (content.length === 0 || content.at(-1) === 0x0a) return;
  const lastNewline = content.lastIndexOf(0x0a);
  fs.truncateSync(eventPath, lastNewline + 1);
}

export function appendJournalRecord(filePath: string, record: { sequence: number }): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  repairPartialTail(filePath);
  const fd = fs.openSync(filePath, "a", 0o600);
  try {
    writeAll(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function readJournalRecords<T extends { sequence: number }>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  const completeTail = content.endsWith("\n");
  const lines = content.split("\n");
  const records: T[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line) continue;
    try {
      const record = JSON.parse(line) as T;
      if (record.sequence !== records.length + 1) {
        throw new Error(`Unexpected event sequence ${record.sequence}.`);
      }
      records.push(record);
    } catch (err) {
      const isPartialTail = !completeTail && index === lines.length - 1;
      if (isPartialTail) break;
      throw new Error(
        `Event journal corruption at line ${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return records;
}

export class RuntimeStore {
  constructor(readonly paths: RuntimePaths) {
    // Preserve compatibility with callers that constructed RuntimePaths before task storage existed.
    paths.tasks ??= path.join(paths.root, "tasks");
    paths.evaluations ??= path.join(paths.root, "evaluations");
    fs.mkdirSync(paths.runs, { recursive: true });
    fs.mkdirSync(paths.tasks, { recursive: true });
    fs.mkdirSync(paths.evaluations, { recursive: true });
    fs.mkdirSync(paths.reports, { recursive: true });
    fs.mkdirSync(paths.worktrees, { recursive: true });
  }

  async withProjectLock<T>(action: () => Promise<T>, options: ProjectLockOptions = {}): Promise<T> {
    fs.mkdirSync(this.paths.root, { recursive: true });
    const release = await lockfile.lock(this.paths.root, {
      realpath: false,
      stale: 15 * 60 * 1000,
      retries: {
        retries: options.retries ?? 120,
        factor: 1,
        minTimeout: options.minTimeoutMs ?? 25,
        maxTimeout: options.maxTimeoutMs ?? 250,
      },
    });
    try {
      return await action();
    } finally {
      await release();
    }
  }

  runDirectory(runId: string): string {
    assertSafeRunId(runId);
    return path.join(this.paths.runs, runId);
  }

  cancellationFile(runId: string): string {
    return path.join(this.runDirectory(runId), "cancel.requested");
  }

  requestCancellation(runId: string): void {
    atomicWrite(
      this.cancellationFile(runId),
      JSON.stringify({ requestedAt: new Date().toISOString(), pid: process.pid }),
    );
  }

  clearCancellation(runId: string): void {
    const filePath = this.cancellationFile(runId);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  isCancellationRequested(runId: string): boolean {
    return fs.existsSync(this.cancellationFile(runId));
  }

  saveRun(run: RunRecord): void {
    run.updatedAt = new Date().toISOString();
    atomicWrite(
      path.join(this.runDirectory(run.runId), "state.json"),
      JSON.stringify(run, null, 2),
    );
  }

  loadRun(runId: string): RunRecord {
    const statePath = path.join(this.runDirectory(runId), "state.json");
    if (!fs.existsSync(statePath)) throw new Error(`Run not found: ${runId}`);
    let run = JSON.parse(fs.readFileSync(statePath, "utf8")) as RunRecord;
    const events = this.readEvents(runId);
    const latest = events.at(-1);
    if (latest && latest.sequence > run.sequence) {
      const snapshot = latest.data?.snapshot as RunRecord | undefined;
      if (
        snapshot?.runId === run.runId &&
        snapshot.sequence === latest.sequence &&
        snapshot.status === latest.status
      ) {
        run = snapshot;
      } else {
        // Older journals did not include snapshots; retain their status-only recovery behavior.
        run.sequence = latest.sequence;
        run.status = latest.status;
      }
      this.saveRun(run);
    }
    return run;
  }

  listRuns(): RunRecord[] {
    if (!fs.existsSync(this.paths.runs)) return [];
    return fs
      .readdirSync(this.paths.runs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        try {
          return [this.loadRun(entry.name)];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  isRunSuperseded(runId: string): boolean {
    if (!fs.existsSync(this.paths.tasks)) return false;
    return fs
      .readdirSync(this.paths.tasks, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .some((entry) => {
        const statePath = path.join(this.paths.tasks, entry.name, "state.json");
        if (!fs.existsSync(statePath)) return false;
        try {
          const value = JSON.parse(fs.readFileSync(statePath, "utf8")) as {
            supersededRunIds?: string[];
          };
          return value.supersededRunIds?.includes(runId) ?? false;
        } catch {
          // Corrupt task state is handled by TaskStore; do not silently authorize promotion.
          return true;
        }
      });
  }

  transition(
    run: RunRecord,
    status: RunStatus,
    message: string,
    data?: Record<string, unknown>,
  ): RunEvent {
    if (run.status !== status && !TRANSITIONS[run.status].has(status)) {
      throw new Error(`Invalid run transition: ${run.status} -> ${status}`);
    }
    run.status = status;
    run.sequence += 1;
    const event: RunEvent = {
      sequence: run.sequence,
      timestamp: new Date().toISOString(),
      status,
      message,
      data: {
        ...data,
        snapshot: JSON.parse(JSON.stringify(run)) as RunRecord,
      },
    };
    const directory = this.runDirectory(run.runId);
    fs.mkdirSync(directory, { recursive: true });
    const eventPath = path.join(directory, "events.jsonl");
    appendJournalRecord(eventPath, event);
    this.saveRun(run);
    return event;
  }

  readEvents(runId: string): RunEvent[] {
    const eventPath = path.join(this.runDirectory(runId), "events.jsonl");
    return readJournalRecords<RunEvent>(eventPath);
  }
}
