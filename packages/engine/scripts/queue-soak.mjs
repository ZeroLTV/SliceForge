import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskEngine, TaskQueueEngine } from "../dist/index.js";

function integerArgument(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function duration() {
  const hours = integerArgument("--duration-hours", 0);
  if (hours) return hours * 60 * 60 * 1000;
  return integerArgument("--duration-ms", 30_000);
}

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-queue-soak-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "sliceforge-soak@example.invalid");
  git(root, "config", "user.name", "SliceForge Queue Soak");
  const agentPath = path.join(root, "soak-agent.cjs");
  fs.writeFileSync(
    agentPath,
    `let input="";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const artifact = request.constraints.requiredArtifacts[0];
  if (request.role !== "reviewer" && artifact) {
    const fs = require("fs");
    const path = require("path");
    const output = path.join(request.cwd, artifact);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, "verified soak output for " + request.runId + "\\n");
  }
  process.stdout.write(JSON.stringify({
    protocolVersion: "1.0",
    status: "completed",
    summary: "soak artifact created",
    artifacts: artifact ? [artifact] : [],
    commandsRun: [],
    diagnostics: []
  }));
});
`,
  );
  const agent = {
    type: "command",
    command: process.execPath,
    args: [agentPath],
    capabilities: ["implementer", "testgen", "reviewer"],
  };
  const config = {
    schemaVersion: 1,
    project: "queue-soak",
    agents: { implementer: agent, testgen: agent, reviewer: agent },
    targets: {
      "soak-a": { root: ".", preset: "generic", commands: {} },
      "soak-b": { root: ".", preset: "generic", commands: {} },
    },
    isolation: { mode: "worktree" },
    gates: {
      order: ["artifact"],
      browser: { enabled: false },
      review: { enabled: false, advisory: true },
    },
    policies: {
      protectedPatterns: ["**/.env*", "sliceforge.config.jsonc", "sliceforge.plan.yaml"],
      maxRetries: 0,
    },
    routing: { fallbackRole: "implementer", minimumReadinessScore: 70 },
    execution: {
      concurrency: 2,
      taskTimeoutMs: 300_000,
      maxRepairAttempts: 1,
      maxRepeatedFailure: 1,
      leaseMs: 30_000,
    },
    documentation: { defaultImpact: "none", requireReviewWhenUncertain: true },
    reporting: { retainRuns: 1_000, maxLogBytes: 65_536 },
    ci: { reportOnly: true },
  };
  const plan = {
    schemaVersion: 1,
    slices: [
      {
        id: "soak-placeholder",
        title: "Queue soak placeholder",
        priority: 1,
        targets: ["soak-a"],
        acceptance: [{ id: "SOAK-001", expected: "placeholder artifact exists" }],
        allowedPaths: ["docs/specs/**"],
        requiredArtifacts: ["docs/specs/placeholder.md"],
        requiredGates: ["artifact"],
      },
    ],
  };
  fs.writeFileSync(path.join(root, "sliceforge.config.jsonc"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(root, "sliceforge.plan.yaml"), JSON.stringify(plan, null, 2));
  fs.writeFileSync(path.join(root, "README.md"), "queue soak fixture\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "queue soak fixture");
  return root;
}

function cleanup(root) {
  try {
    const worktrees = git(root, "worktree", "list", "--porcelain")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length));
    for (const worktree of worktrees) {
      if (path.resolve(worktree) !== path.resolve(root)) {
        try {
          git(root, "worktree", "remove", "--force", worktree);
        } catch {
          // The final repository removal also clears stale metadata.
        }
      }
    }
    git(root, "worktree", "prune");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

async function main() {
  const durationMs = duration();
  const batchSize = integerArgument("--batch-size", 2);
  const concurrency = integerArgument("--concurrency", 2);
  const root = createRepository();
  const startedAt = Date.now();
  const originalHead = git(root, "rev-parse", "HEAD");
  const seen = new Set();
  let cycles = 0;
  let created = 0;

  try {
    do {
      const tasks = await TaskEngine.open(root);
      const batch = [];
      for (let offset = 0; offset < batchSize; offset++) {
        const ordinal = created++;
        const target = ordinal % 2 === 0 ? "soak-a" : "soak-b";
        const task = await tasks.create(
          `Allow a user to create deterministic soak artifact ${ordinal} when the queue runs, produce expected content, and verify completion with an artifact test.`,
          { targets: [target], priority: ordinal },
        );
        if (task.status !== "awaiting_approval") {
          throw new Error(`Task ${task.taskId} was not ready for approval: ${task.status}`);
        }
        tasks.approve(task.taskId);
        batch.push(task.taskId);
      }

      const result = await (await TaskQueueEngine.open(root)).start(concurrency);
      if (result.failed.length)
        throw new Error(`Queue failed task(s): ${result.failed.join(", ")}`);
      for (const taskId of result.processed) {
        if (seen.has(taskId)) throw new Error(`Queue processed task more than once: ${taskId}`);
        seen.add(taskId);
      }
      const missing = batch.filter((taskId) => !result.processed.includes(taskId));
      if (missing.length) throw new Error(`Queue lost task(s): ${missing.join(", ")}`);
      for (const taskId of batch) {
        const task = tasks.tasks.load(taskId);
        if (task.status !== "ready_to_promote" || !task.execution?.bundleRunId) {
          throw new Error(`Task ${taskId} stopped at ${task.status} without a bundle run.`);
        }
      }
      if (git(root, "rev-parse", "HEAD") !== originalHead || git(root, "status", "--porcelain")) {
        throw new Error("Original worktree changed during queue soak.");
      }
      cycles += 1;
      process.stdout.write(
        `${JSON.stringify({ event: "cycle", cycles, tasks: seen.size, elapsedMs: Date.now() - startedAt })}\n`,
      );
    } while (Date.now() - startedAt < durationMs);

    process.stdout.write(
      `${JSON.stringify({
        event: "complete",
        passed: true,
        durationMs: Date.now() - startedAt,
        cycles,
        tasksCreated: created,
        uniqueTasksProcessed: seen.size,
        duplicateTasks: 0,
        lostTasks: 0,
        originalMutations: 0,
      })}\n`,
    );
  } finally {
    cleanup(root);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
