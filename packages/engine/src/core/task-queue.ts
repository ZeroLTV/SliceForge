import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { RunRecord, SliceDefinition, TaskRecord } from "./contracts.js";
import { SliceForgeOrchestrator } from "./orchestrator.js";
import { atomicWrite } from "./runtime-store.js";
import { sliceGraphFingerprint, TaskEngine } from "./task-engine.js";
import { GitService } from "./git-service.js";

interface QueueControl {
  paused: boolean;
  updatedAt: string;
}

export interface QueueRunResult {
  processed: string[];
  readyToPromote: string[];
  failed: string[];
}

function orderedSlices(slices: SliceDefinition[]): SliceDefinition[] {
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  const ordered: SliceDefinition[] = [];
  const visited = new Set<string>();
  const visit = (slice: SliceDefinition): void => {
    if (visited.has(slice.id)) return;
    for (const dependency of slice.dependsOn ?? []) visit(byId.get(dependency)!);
    visited.add(slice.id);
    ordered.push(slice);
  };
  for (const slice of slices) visit(slice);
  return ordered;
}

export class TaskQueueEngine {
  private readonly orchestrator = new SliceForgeOrchestrator();

  private constructor(private readonly engine: TaskEngine) {}

  static async open(projectRoot: string): Promise<TaskQueueEngine> {
    return new TaskQueueEngine(await TaskEngine.open(projectRoot));
  }

  private withQueueLock<T>(action: () => Promise<T>): Promise<T> {
    return this.engine.runtime.withProjectLock(action, {
      retries: 120,
      minTimeoutMs: 25,
      maxTimeoutMs: 100,
    });
  }

  private controlPath(): string {
    return path.join(this.engine.runtime.paths.root, "queue.json");
  }

  private control(): QueueControl {
    const filePath = this.controlPath();
    return fs.existsSync(filePath)
      ? (JSON.parse(fs.readFileSync(filePath, "utf8")) as QueueControl)
      : { paused: false, updatedAt: new Date(0).toISOString() };
  }

  setPaused(paused: boolean): QueueControl {
    const control = { paused, updatedAt: new Date().toISOString() };
    atomicWrite(this.controlPath(), JSON.stringify(control, null, 2));
    return control;
  }

  status(): { control: QueueControl; tasks: TaskRecord[] } {
    return {
      control: this.control(),
      tasks: this.engine.tasks
        .list()
        .filter((task) => ["queued", "running", "blocked", "failed"].includes(task.status)),
    };
  }

  private async claim(taskId: string, workerId: string): Promise<TaskRecord | null | undefined> {
    return this.withQueueLock(async () => {
      if (this.control().paused) return undefined;
      const task = this.engine.tasks.load(taskId);
      if (task.status !== "queued") return undefined;
      if (
        !task.graph ||
        task.graph.fingerprint !== sliceGraphFingerprint(task.graph) ||
        task.approvedFingerprint !== task.graph.fingerprint
      ) {
        this.engine.tasks.transition(
          task,
          "blocked",
          "Queue rejected a missing or non-approved graph fingerprint.",
        );
        return undefined;
      }
      const network = task.graph.slices.some((slice) =>
        (slice.requiredGates ?? []).some((gate) =>
          ["integration", "e2e", "browser"].includes(gate),
        ),
      );
      const running = this.engine.tasks
        .list()
        .filter((candidate) => candidate.status === "running");
      const targetLocks = new Set(task.request.targets);
      const conflicts = running.some((candidate) =>
        candidate.queue?.resources?.targetLocks.some((target) => targetLocks.has(target)),
      );
      if (conflicts) return null;
      const now = Date.now();
      const leaseMs = this.engine.config.execution?.leaseMs ?? 60_000;
      task.queue = {
        ...task.queue!,
        attempts: task.queue!.attempts + 1,
        lease: {
          workerId,
          acquiredAt: new Date(now).toISOString(),
          heartbeatAt: new Date(now).toISOString(),
          expiresAt: new Date(now + leaseMs).toISOString(),
        },
        resources: { targetLocks: [...targetLocks], network },
      };
      this.engine.tasks.transition(task, "running", "Queue worker claimed the approved task.", {
        workerId,
      });
      return task;
    });
  }

  private async recoverExpiredLeases(): Promise<void> {
    await this.withQueueLock(async () => {
      const now = Date.now();
      for (const task of this.engine.tasks.list()) {
        if (
          task.status !== "running" ||
          !task.queue?.lease ||
          Date.parse(task.queue.lease.expiresAt) > now
        ) {
          continue;
        }
        task.queue = { ...task.queue, lease: undefined };
        this.engine.tasks.transition(
          task,
          "blocked",
          "Expired worker lease detected during recovery.",
        );
        this.engine.tasks.transition(task, "queued", "Task requeued after expired worker lease.");
      }
    });
  }

  private async heartbeat(taskId: string, workerId: string): Promise<void> {
    await this.withQueueLock(async () => {
      const task = this.engine.tasks.load(taskId);
      if (task.status !== "running" || task.queue?.lease?.workerId !== workerId) return;
      const now = Date.now();
      const leaseMs = this.engine.config.execution?.leaseMs ?? 60_000;
      task.queue.lease.heartbeatAt = new Date(now).toISOString();
      task.queue.lease.expiresAt = new Date(now + leaseMs).toISOString();
      this.engine.tasks.save(task);
    });
  }

  private async ensureStaging(taskId: string): Promise<TaskRecord> {
    const git = new GitService(this.engine.projectRoot);
    let task = await this.withQueueLock(async () => {
      const current = this.engine.tasks.load(taskId);
      if (current.execution) return current;
      if (!(await git.isClean())) {
        throw new Error("Original working tree must be clean before task staging starts.");
      }
      const baseSha = await git.head();
      const baseBranch = await git.branch();
      const stagingBranch = `sliceforge/task-staging/${current.taskId}/r${current.revision}`;
      const stagingWorktreePath = path.join(
        this.engine.runtime.paths.worktrees,
        `task-${current.taskId}-r${current.revision}-staging`,
      );
      current.execution = {
        baseBranch,
        baseSha,
        stagingBranch,
        stagingWorktreePath,
        integratedSliceIds: [],
      };
      this.engine.tasks.transition(
        current,
        "running",
        "Task staging metadata recorded before worktree creation.",
      );
      return current;
    });
    await git.restoreWorktree(
      task.execution!.stagingWorktreePath,
      task.execution!.stagingBranch,
      task.execution!.baseSha,
    );
    task = this.engine.tasks.load(taskId);
    return task;
  }

  private async recordPendingRun(taskId: string, runId: string): Promise<void> {
    await this.withQueueLock(async () => {
      const task = this.engine.tasks.load(taskId);
      task.runIds.push(runId);
      task.execution!.pendingRunId = runId;
      this.engine.tasks.transition(task, "running", "Slice candidate recorded for staging.", {
        runId,
      });
    });
  }

  private async markIntegrated(taskId: string, sliceId: string): Promise<void> {
    await this.withQueueLock(async () => {
      const task = this.engine.tasks.load(taskId);
      task.execution!.integratedSliceIds = [
        ...new Set([...task.execution!.integratedSliceIds, sliceId]),
      ];
      task.execution!.pendingRunId = undefined;
      this.engine.tasks.transition(
        task,
        "running",
        "Verified slice integrated into task staging.",
        {
          sliceId,
        },
      );
    });
  }

  private async stopForRun(taskId: string, run: RunRecord): Promise<void> {
    await this.withQueueLock(async () => {
      const task = this.engine.tasks.load(taskId);
      task.queue = task.queue ? { ...task.queue, lease: undefined } : undefined;
      task.lastError = run.priorFailures.at(-1);
      const status = run.status === "needs_attention" ? "needs_attention" : "failed";
      this.engine.tasks.transition(
        task,
        status,
        run.status === "needs_attention"
          ? "A staged slice requires explicit human attention before integration."
          : "A staged slice failed and the task bundle was not created.",
        { runId: run.runId },
      );
    });
  }

  private async recoverPending(task: TaskRecord): Promise<"continue" | "stopped"> {
    const runId = task.execution?.pendingRunId;
    if (!runId) return "continue";
    let outcome = await this.orchestrator.inspect(task.execution!.stagingWorktreePath, runId);
    if (
      !["ready_to_promote", "needs_attention", "promoted", "failed", "blocked"].includes(
        outcome.run.status,
      )
    ) {
      outcome = await this.orchestrator.resume(task.execution!.stagingWorktreePath, runId);
    }
    if (outcome.run.status === "ready_to_promote") {
      await this.orchestrator.promote(task.execution!.stagingWorktreePath, runId);
      await this.markIntegrated(task.taskId, outcome.run.sliceId);
      return "continue";
    }
    if (outcome.run.status === "promoted") {
      await this.markIntegrated(task.taskId, outcome.run.sliceId);
      return "continue";
    }
    await this.stopForRun(task.taskId, outcome.run);
    return "stopped";
  }

  private async finishBundle(taskId: string, run: RunRecord): Promise<void> {
    await this.withQueueLock(async () => {
      const current = this.engine.tasks.load(taskId);
      if (!current.runIds.includes(run.runId)) current.runIds.push(run.runId);
      current.execution!.bundleRunId = run.runId;
      const completedLease = current.queue?.lease;
      current.queue = current.queue ? { ...current.queue, lease: undefined } : undefined;
      current.evidence = (current.graph?.evidence ?? []).map((requirement) => {
        const coverage = run.acceptanceCoverage?.find(
          (item) => item.id === requirement.acceptanceId,
        );
        return {
          id: `${run.runId}:${requirement.acceptanceId}:${requirement.kind}`,
          ...requirement,
          status: coverage?.status ?? "unverified",
          fingerprint: run.finalFingerprint ?? "unavailable",
          recordedAt: new Date().toISOString(),
          details: coverage?.evidence.length
            ? `Verified by ${coverage.evidence.join(", ")}`
            : `No deterministic evidence was recorded by bundle ${run.runId}`,
        };
      });
      const elapsed = completedLease ? Date.now() - Date.parse(completedLease.acquiredAt) : 0;
      const cost = current.runIds
        .map((id) => {
          try {
            return this.engine.runtime.loadRun(id);
          } catch {
            return undefined;
          }
        })
        .reduce(
          (sum, item) =>
            sum +
            Object.values(item?.agentResponses ?? {}).reduce(
              (subtotal, response) => subtotal + (response?.usage?.estimatedCostUSD ?? 0),
              0,
            ),
          0,
        );
      const overDuration = Boolean(
        current.queue?.budget?.maxDurationMs && elapsed > current.queue.budget.maxDurationMs,
      );
      const costLimit =
        current.queue?.budget?.maxCostUSD ?? this.engine.config.routing?.maxEstimatedCostUSD;
      const overCost = costLimit !== undefined && cost > costLimit;
      if (run.status === "promoted") {
        this.engine.tasks.transition(
          current,
          "ready_to_promote",
          "Recovered a task bundle that was promoted before task state was updated.",
          { runId: run.runId },
        );
        this.engine.tasks.transition(current, "promoting", "Synchronizing recovered promotion.", {
          runId: run.runId,
        });
        this.engine.tasks.transition(current, "promoted", "Recovered promoted task bundle.", {
          runId: run.runId,
        });
      } else if (run.status === "ready_to_promote" && !overDuration && !overCost) {
        this.engine.tasks.transition(
          current,
          "ready_to_promote",
          "Integrated task bundle passed all final gates; manual promote is available.",
          { runId: run.runId },
        );
      } else if (run.status === "ready_to_promote" || run.status === "needs_attention") {
        this.engine.tasks.transition(
          current,
          "needs_attention",
          run.status === "needs_attention"
            ? "Integrated task bundle requires explicit attention."
            : `Integrated task bundle exceeded ${overDuration ? "duration" : "cost"} budget.`,
          { runId: run.runId, elapsed, cost },
        );
      } else {
        current.lastError = run.priorFailures.at(-1) ?? `Bundle ended as ${run.status}`;
        this.engine.tasks.transition(
          current,
          "failed",
          "Integrated task bundle failed final validation.",
          { runId: run.runId },
        );
      }
    });
  }

  private async recordBundleRun(taskId: string, runId: string): Promise<void> {
    await this.withQueueLock(async () => {
      const task = this.engine.tasks.load(taskId);
      task.execution!.bundleRunId = runId;
      if (!task.runIds.includes(runId)) task.runIds.push(runId);
      this.engine.tasks.transition(task, "running", "Final task bundle run recorded.", { runId });
    });
  }

  private async cleanupStaging(task: TaskRecord): Promise<void> {
    if (!task.execution) return;
    const git = new GitService(this.engine.projectRoot);
    try {
      await git.removeWorktree(task.execution.stagingWorktreePath, true);
      await git.deleteBranch(task.execution.stagingBranch);
    } catch {
      // The immutable bundle retains the verified tree; clean can retry stale staging cleanup.
    }
  }

  private async executeTask(task: TaskRecord): Promise<RunRecord | undefined> {
    let current = await this.ensureStaging(task.taskId);
    if ((await this.recoverPending(current)) === "stopped") return undefined;
    current = this.engine.tasks.load(task.taskId);
    for (const slice of orderedSlices(current.graph!.slices)) {
      if (current.execution!.integratedSliceIds.includes(slice.id)) continue;
      const outcome = await this.orchestrator.startDefinition(
        current.execution!.stagingWorktreePath,
        { ...slice, dependsOn: undefined },
      );
      await this.recordPendingRun(task.taskId, outcome.run.runId);
      if (outcome.run.status !== "ready_to_promote") {
        await this.stopForRun(task.taskId, outcome.run);
        return undefined;
      }
      await this.orchestrator.promote(current.execution!.stagingWorktreePath, outcome.run.runId);
      await this.markIntegrated(task.taskId, slice.id);
      current = this.engine.tasks.load(task.taskId);
    }
    const expectedSliceIds = current
      .graph!.slices.map((slice) => slice.id)
      .sort()
      .join("\0");
    const existingBundleId =
      current.execution!.bundleRunId ??
      this.engine.runtime.listRuns().find(
        (run) =>
          run.kind === "task" &&
          run.sliceId === `task:${current.taskId}` &&
          run.baseSha === current.execution!.baseSha &&
          ["ready_to_promote", "needs_attention", "promoted"].includes(run.status) &&
          (run.bundleSlices ?? [])
            .map((slice) => slice.id)
            .sort()
            .join("\0") === expectedSliceIds &&
          !this.engine.runtime.isRunSuperseded(run.runId),
      )?.runId;
    if (existingBundleId) {
      await this.recordBundleRun(current.taskId, existingBundleId);
      const existing = await this.orchestrator.inspect(this.engine.projectRoot, existingBundleId);
      await this.finishBundle(current.taskId, existing.run);
      await this.cleanupStaging(current);
      return existing.run;
    }
    const git = new GitService(this.engine.projectRoot);
    const stagingHead = await git.head(current.execution!.stagingWorktreePath);
    const treeSha = await git.tree(stagingHead, current.execution!.stagingWorktreePath);
    const bundleCommit = await git.createCommitFromTree(
      treeSha,
      current.execution!.baseSha,
      `sliceforge(task:${current.taskId}): ${current.request.request.split(/\r?\n/, 1)[0].slice(0, 100)}`,
    );
    const bundle = await this.orchestrator.registerBundle(this.engine.projectRoot, {
      taskId: current.taskId,
      baseBranch: current.execution!.baseBranch,
      baseSha: current.execution!.baseSha,
      commitSha: bundleCommit,
      slices: current.graph!.slices,
    });
    await this.recordBundleRun(current.taskId, bundle.run.runId);
    await this.finishBundle(current.taskId, bundle.run);
    if (["ready_to_promote", "needs_attention"].includes(bundle.run.status)) {
      await this.cleanupStaging(current);
    }
    return bundle.run;
  }

  async start(concurrency?: number): Promise<QueueRunResult> {
    if (this.control().paused) throw new Error("Queue is paused. Run 'sliceforge queue resume'.");
    await this.recoverExpiredLeases();
    const limit = concurrency ?? this.engine.config.execution?.concurrency ?? 1;
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) {
      throw new Error("Queue concurrency must be an integer between 1 and 16.");
    }
    const candidates = this.engine.tasks
      .list()
      .filter((task) => task.status === "queued")
      .sort(
        (a, b) => a.request.priority - b.request.priority || a.createdAt.localeCompare(b.createdAt),
      );
    const result: QueueRunResult = { processed: [], readyToPromote: [], failed: [] };
    let cursor = 0;
    const worker = async (index: number): Promise<void> => {
      const workerId = `${process.pid}-${index}-${crypto.randomBytes(3).toString("hex")}`;
      while (cursor < candidates.length && !this.control().paused) {
        const task = candidates[cursor++];
        let claimed = await this.claim(task.taskId, workerId);
        while (claimed === null && !this.control().paused) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          claimed = await this.claim(task.taskId, workerId);
        }
        if (!claimed?.graph) continue;
        result.processed.push(claimed.taskId);
        const heartbeatMs = Math.max(
          1000,
          Math.floor((this.engine.config.execution?.leaseMs ?? 60_000) / 3),
        );
        const heartbeat = setInterval(() => {
          void this.heartbeat(claimed.taskId, workerId).catch(() => {
            // The final transition records a durable error if the worker loses ownership.
          });
        }, heartbeatMs);
        try {
          const bundle = await this.executeTask(claimed);
          const finalTask = this.engine.tasks.load(claimed.taskId);
          if (bundle && finalTask.status === "ready_to_promote") {
            result.readyToPromote.push(claimed.taskId);
          } else {
            result.failed.push(claimed.taskId);
          }
        } catch (error) {
          await this.withQueueLock(async () => {
            const current = this.engine.tasks.load(claimed.taskId);
            current.lastError = error instanceof Error ? error.message : String(error);
            current.queue = current.queue ? { ...current.queue, lease: undefined } : undefined;
            this.engine.tasks.transition(current, "failed", "Queue execution failed.", {
              error: current.lastError,
            });
          });
          result.failed.push(claimed.taskId);
        } finally {
          clearInterval(heartbeat);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, candidates.length) }, (_, index) => worker(index)),
    );
    return result;
  }

  async acceptAttention(taskId: string): Promise<TaskRecord> {
    const task = this.engine.tasks.load(taskId);
    if (task.status !== "needs_attention" || !task.execution?.pendingRunId) {
      throw new Error(
        `Task ${taskId} has no staged slice awaiting attention. Inspect its bundle run instead.`,
      );
    }
    const runId = task.execution.pendingRunId;
    const outcome = await this.orchestrator.promote(
      task.execution.stagingWorktreePath,
      runId,
      true,
    );
    return this.withQueueLock(async () => {
      const current = this.engine.tasks.load(taskId);
      current.execution!.integratedSliceIds = [
        ...new Set([...current.execution!.integratedSliceIds, outcome.run.sliceId]),
      ];
      current.execution!.pendingRunId = undefined;
      current.lastError = undefined;
      this.engine.tasks.transition(
        current,
        "queued",
        "Human attention accepted; task staging will continue from the verified slice.",
        { runId },
      );
      return current;
    });
  }

  async syncPromoted(runId: string): Promise<void> {
    await this.withQueueLock(async () => {
      const task = this.engine.tasks.list().find((candidate) => candidate.runIds.includes(runId));
      if (!task || task.status === "promoted") return;
      if (task.status !== "ready_to_promote" && task.status !== "needs_attention") return;
      this.engine.tasks.transition(
        task,
        "promoting",
        "Synchronizing promoted run with task state.",
        { runId },
      );
      this.engine.tasks.transition(task, "promoted", "Verified task promoted successfully.", {
        runId,
      });
    });
  }
}
