#!/usr/bin/env node

import { Command } from "commander";
import { createRequire } from "module";
import * as path from "path";
import { initializeProject } from "../core/onboarding.js";
import { loadConfig, loadPlan, validateProject } from "../core/config-loader.js";
import { runDoctor } from "../core/doctor.js";
import { GitService } from "../core/git-service.js";
import { getRuntimePaths, RuntimeStore } from "../core/runtime-store.js";
import { HtmlReporter } from "../core/reporter.js";
import { SliceForgeOrchestrator, type RunOutcome } from "../core/orchestrator.js";
import { ExitCode, type RunRecord } from "../core/contracts.js";
import type { TaskRecord } from "../core/contracts.js";
import { TaskEngine } from "../core/task-engine.js";
import { TaskQueueEngine } from "../core/task-queue.js";
import { EvaluationEngine } from "../core/evaluation.js";

const require = createRequire(import.meta.url);
const packageVersion = (require("../../package.json") as { version: string }).version;

const orchestrator = new SliceForgeOrchestrator();

function classifyError(error: unknown): ExitCode {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /config|schema|parse|plan|not found|unknown target|dependency cycle|escapes|unsafe path|executable|invalid|expected|must be|no answers supplied|interval/i.test(
      message,
    )
  )
    return ExitCode.ConfigurationError;
  if (/clean|blocked|attention|promot|HEAD changed|cancelled|approval/i.test(message))
    return ExitCode.Blocked;
  if (/gate|test|build|lint|artifact|policy|agent/i.test(message)) return ExitCode.GateFailed;
  return ExitCode.InternalError;
}

interface ProgressReporter {
  update(message: string): void;
  done(message: string): void;
  fail(message: string): void;
}

function formatElapsed(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function createProgressReporter(): ProgressReporter {
  const startedAt = Date.now();
  const interactive = process.stderr.isTTY === true;
  const frames = ["-", "\\", "|", "/"];
  let frame = 0;
  let current = "";
  let timer: NodeJS.Timeout | undefined;

  const render = (): void => {
    if (!interactive) return;
    process.stderr.write(
      `\r\x1b[2K${frames[frame]} ${current} (${formatElapsed(Date.now() - startedAt)})`,
    );
    frame = (frame + 1) % frames.length;
  };

  const update = (message: string): void => {
    if (message === current) return;
    current = message;
    if (!interactive) {
      process.stderr.write(`[SliceForge] ${message}\n`);
      return;
    }
    render();
    timer ??= setInterval(render, 120);
  };

  const stop = (message: string): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (interactive) process.stderr.write(`\r\x1b[2K`);
    process.stderr.write(`[SliceForge] ${message} (${formatElapsed(Date.now() - startedAt)})\n`);
  };

  return {
    update,
    done: (message) => stop(message),
    fail: (message) => stop(message),
  };
}

async function action(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (err) {
    const exitCode = classifyError(err);
    const impact =
      exitCode === ExitCode.ConfigurationError
        ? "The run did not start because its configuration or environment is unsafe or incomplete."
        : exitCode === ExitCode.Blocked
          ? "No code was promoted; explicit user action is required."
          : exitCode === ExitCode.GateFailed
            ? "Validation did not establish a trustworthy result, so promotion is disabled."
            : "The operation stopped without declaring success; local recovery state was retained when possible.";
    const next =
      exitCode === ExitCode.ConfigurationError ? "sliceforge doctor" : "sliceforge status";
    console.error(`\nCause:  ${err instanceof Error ? err.message : String(err)}`);
    console.error(`Impact: ${impact}`);
    console.error(`Next:   ${next}`);
    process.exitCode = exitCode;
  }
}

function statusColor(status: RunRecord["status"]): string {
  if (["promoted", "ready_to_promote"].includes(status)) return `\x1b[32m${status}\x1b[0m`;
  if (["failed", "blocked", "cancelled"].includes(status)) return `\x1b[31m${status}\x1b[0m`;
  if (status === "needs_attention") return `\x1b[33m${status}\x1b[0m`;
  return `\x1b[36m${status}\x1b[0m`;
}

function printOutcome(outcome: RunOutcome): void {
  const { run, reportPath } = outcome;
  console.log(`\nRun:    ${run.runId}`);
  console.log(`Slice:  ${run.sliceId}`);
  console.log(`Status: ${statusColor(run.status)}`);
  console.log(`Report: ${reportPath}`);
  if (run.status === "ready_to_promote") console.log(`Next:   sliceforge promote ${run.runId}`);
  else if (run.status === "needs_attention") {
    console.log(`Next:   sliceforge inspect ${run.runId}`);
    process.exitCode = ExitCode.Blocked;
  } else if (run.status === "blocked") {
    console.log(`Next:   sliceforge rebase ${run.runId}`);
    process.exitCode = ExitCode.Blocked;
  } else if (run.status === "failed") {
    console.log(`Next:   sliceforge inspect ${run.runId}`);
    process.exitCode = ExitCode.GateFailed;
  }
}

async function reporterFor(projectRoot: string): Promise<HtmlReporter> {
  const git = new GitService(projectRoot);
  await git.assertRepository();
  const paths = getRuntimePaths(projectRoot, await git.commonDir());
  const config = loadConfig(projectRoot);
  if (config.reporting.directory)
    paths.reports = path.resolve(paths.root, config.reporting.directory);
  return new HtmlReporter(new RuntimeStore(paths));
}

function parseAgent(value: string): "codex" | "claude" | "cursor" {
  if (!["codex", "claude", "cursor"].includes(value))
    throw new Error(`Invalid agent '${value}'. Expected codex, claude, or cursor.`);
  return value as "codex" | "claude" | "cursor";
}

function parseModel(value: string): string {
  const model = value.trim();
  if (!model) throw new Error("Invalid model: value cannot be empty.");
  return model;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function taskNextAction(task: TaskRecord): string {
  if (task.status === "clarifying") return `sliceforge task answer ${task.taskId}`;
  if (task.status === "awaiting_approval") return `sliceforge task approve ${task.taskId}`;
  if (task.status === "queued") return "sliceforge queue start";
  if (task.status === "needs_attention" && task.execution?.pendingRunId) {
    return `sliceforge task accept-attention ${task.taskId}`;
  }
  if (task.status === "ready_to_promote") {
    const runId = task.runIds.at(-1);
    return runId ? `sliceforge promote ${runId}` : `sliceforge task inspect ${task.taskId}`;
  }
  return `sliceforge task inspect ${task.taskId}`;
}

function printTask(task: TaskRecord): void {
  console.log(`\nTask:      ${task.taskId}`);
  console.log(`Status:    ${task.status}`);
  console.log(`Readiness: ${task.packet.readinessScore}/100`);
  if (task.packet.questions.some((question) => !question.answer)) {
    console.log("Questions:");
    for (const question of task.packet.questions.filter((item) => !item.answer)) {
      console.log(`- ${question.id}: ${question.question}`);
      console.log(`  Recommended: ${question.recommendation}`);
    }
  }
  if (task.graph)
    console.log(
      `Plan:      ${task.graph.slices.length} slice(s), ${task.graph.fingerprint.slice(0, 12)}`,
    );
  console.log(`Next:      ${taskNextAction(task)}`);
}

async function evaluationEngine(projectRoot: string): Promise<EvaluationEngine> {
  const config = loadConfig(projectRoot);
  const git = new GitService(projectRoot);
  await git.assertRepository();
  return new EvaluationEngine(
    projectRoot,
    config,
    new RuntimeStore(getRuntimePaths(projectRoot, await git.commonDir())),
  );
}

export function buildProgram(): Command {
  const program = new Command()
    .name("sliceforge")
    .description("SliceForge - reliable local-first AI Harness Engine")
    .version(packageVersion);

  program
    .command("init")
    .description("Detect the project and create JSONC/YAML configuration")
    .option("--agent <agent>", "codex | claude | cursor")
    .option("--model <model>", "model identifier applied to generated agent roles")
    .option("-y, --yes", "accept detected defaults without prompts")
    .option("--force", "replace existing config and plan")
    .action((options) =>
      action(async () => {
        const model = options.model ? parseModel(options.model) : undefined;
        const result = await initializeProject(process.cwd(), {
          agent: options.agent ? parseAgent(options.agent) : undefined,
          ...(model ? { model } : {}),
          yes: Boolean(options.yes),
          force: Boolean(options.force),
        });
        console.log("\nSliceForge initialized.");
        for (const message of result.messages) console.log(`- ${message}`);
      }),
    );

  program
    .command("doctor")
    .description("Validate Git, agents, targets, commands, plan, and capabilities")
    .action(() =>
      action(async () => {
        const root = process.cwd();
        const config = loadConfig(root);
        const plan = loadPlan(root, config);
        const report = await runDoctor(root, config, plan);
        for (const check of report.checks) {
          const marker =
            check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
          console.log(`${marker.padEnd(5)} ${check.message}`);
          if (check.remediation) console.log(`      Fix: ${check.remediation}`);
        }
        try {
          console.log(`\nReport: ${(await reporterFor(root)).writeDoctor(report)}`);
        } catch {
          /* Git may not be valid yet. */
        }
        if (!report.ok) process.exitCode = ExitCode.ConfigurationError;
      }),
    );

  const plan = program.command("plan").description("Inspect and validate the SliceForge plan");
  plan
    .command("validate")
    .description("Validate schemas, targets, paths, and dependency graph")
    .action(() =>
      action(async () => {
        const result = validateProject(process.cwd());
        console.log(
          `Plan valid: ${result.plan.slices.length} slice(s), ${Object.keys(result.config.targets).length} target(s).`,
        );
      }),
    );

  program
    .command("do <request>")
    .description("Build a schema-validated, clarified task plan from a raw request")
    .option("--from <file>", "append a local Markdown or issue-export file")
    .option("--image <path>", "attach a local reference image", collect, [])
    .option("--figma <url>", "attach an HTTPS Figma reference")
    .option("--target <target>", "select an affected target", collect, [])
    .option("--constraint <text>", "add an implementation constraint", collect, [])
    .option("--priority <number>", "queue priority; lower values run first", "50")
    .action((request, options) =>
      action(async () => {
        const progress = createProgressReporter();
        progress.update("Starting task intake...");
        let intakeComplete = false;
        try {
          const engine = await TaskEngine.open(process.cwd());
          const task = await engine.create(request, {
            from: options.from,
            images: options.image,
            figma: options.figma,
            targets: options.target,
            constraints: options.constraint,
            priority: Number(options.priority),
            onProgress: progress.update,
          });
          progress.done("Task intake complete");
          intakeComplete = true;
          printTask(task);
          console.log(
            `Report:    ${new HtmlReporter(engine.runtime).writeTask(task, engine.tasks.events(task.taskId))}`,
          );
          if (task.status === "clarifying") process.exitCode = ExitCode.Blocked;
        } catch (error) {
          if (!intakeComplete) progress.fail("Task intake stopped");
          throw error;
        }
      }),
    );

  const task = program.command("task").description("Inspect and control task-level workflows");
  task
    .command("list")
    .description("List local Harness Engine tasks")
    .option("--json", "emit machine-readable JSON")
    .action((options) =>
      action(async () => {
        const tasks = (await TaskEngine.open(process.cwd())).tasks.list();
        if (options.json) return void console.log(JSON.stringify(tasks, null, 2));
        if (!tasks.length) return void console.log('No tasks yet. Next: sliceforge do "<request>"');
        for (const item of tasks)
          console.log(
            `${item.taskId}  ${item.status.padEnd(19)}  ${item.request.request.split(/\r?\n/, 1)[0]}`,
          );
      }),
    );
  task
    .command("inspect <taskId>")
    .description("Show request, blockers, approved graph and evidence")
    .option("--json", "emit machine-readable JSON")
    .action((taskId, options) =>
      action(async () => {
        const engine = await TaskEngine.open(process.cwd());
        const item = engine.tasks.load(taskId);
        if (options.json) console.log(JSON.stringify(item, null, 2));
        else {
          printTask(item);
          console.log(
            `Report:    ${new HtmlReporter(engine.runtime).writeTask(item, engine.tasks.events(item.taskId))}`,
          );
        }
      }),
    );
  task
    .command("answer <taskId>")
    .description("Answer blocking questions as --set question-id=answer or interactively")
    .option("--set <answer>", "question-id=answer", collect, [])
    .action((taskId, options) =>
      action(async () => {
        const engine = await TaskEngine.open(process.cwd());
        const current = engine.tasks.load(taskId);
        const answers: Record<string, string> = {};
        for (const value of options.set as string[]) {
          const separator = value.indexOf("=");
          if (separator <= 0)
            throw new Error(`Invalid answer '${value}'. Expected question-id=answer.`);
          answers[value.slice(0, separator)] = value.slice(separator + 1);
        }
        if (!Object.keys(answers).length && process.stdin.isTTY && process.stdout.isTTY) {
          const { input } = await import("@inquirer/prompts");
          for (const question of current.packet.questions.filter((item) => !item.answer)) {
            answers[question.id] = await input({
              message: question.question,
              default: question.recommendation,
            });
          }
        }
        if (!Object.keys(answers).length)
          throw new Error("No answers supplied. Use --set question-id=answer.");
        printTask(await engine.answer(taskId, answers));
      }),
    );
  task
    .command("approve <taskId>")
    .description("Approve the immutable plan fingerprint and enqueue the task")
    .action((taskId) =>
      action(async () => printTask((await TaskEngine.open(process.cwd())).approve(taskId))),
    );
  task
    .command("revise <taskId>")
    .description("Create a new immutable plan revision from explicit feedback")
    .requiredOption("--feedback <text>", "what must change in the next revision")
    .action((taskId, options) =>
      action(async () =>
        printTask(await (await TaskEngine.open(process.cwd())).revise(taskId, options.feedback)),
      ),
    );
  task
    .command("accept-attention <taskId>")
    .description("Accept a staged slice manual/review checkpoint and continue the task graph")
    .action((taskId) =>
      action(async () =>
        printTask(await (await TaskQueueEngine.open(process.cwd())).acceptAttention(taskId)),
      ),
    );
  task
    .command("cancel <taskId>")
    .description("Cancel a task without modifying the original worktree")
    .action((taskId) =>
      action(async () => printTask((await TaskEngine.open(process.cwd())).cancel(taskId))),
    );

  const queue = program
    .command("queue")
    .description("Run approved tasks from the persistent queue");
  queue
    .command("start")
    .description("Process queued tasks until empty, paused or blocked")
    .option("--concurrency <number>", "maximum concurrent isolated task runs")
    .option("--watch", "keep polling for newly approved tasks")
    .option("--poll-ms <number>", "watch polling interval", "5000")
    .action((options) =>
      action(async () => {
        const queue = await TaskQueueEngine.open(process.cwd());
        const concurrency =
          options.concurrency === undefined ? undefined : Number(options.concurrency);
        const runCycle = async (): Promise<void> => {
          const progress = createProgressReporter();
          progress.update("Starting queue...");
          let cycleComplete = false;
          try {
            const result = await queue.start(concurrency, progress.update);
            progress.done("Queue cycle complete");
            cycleComplete = true;
            console.log(
              `Processed: ${result.processed.length}  Ready: ${result.readyToPromote.length}  Failed: ${result.failed.length}`,
            );
            if (result.failed.length) process.exitCode = ExitCode.GateFailed;
          } catch (error) {
            if (!cycleComplete) progress.fail("Queue cycle stopped");
            throw error;
          }
        };
        await runCycle();
        if (options.watch) {
          const pollMs = Number(options.pollMs);
          if (!Number.isInteger(pollMs) || pollMs < 1000 || pollMs > 300_000) {
            throw new Error("Queue poll interval must be between 1000 and 300000 ms.");
          }
          let stopping = false;
          const stop = (): void => {
            stopping = true;
          };
          process.once("SIGINT", stop);
          process.once("SIGTERM", stop);
          try {
            while (!stopping && !queue.status().control.paused) {
              await new Promise((resolve) => setTimeout(resolve, pollMs));
              if (!stopping) await runCycle();
            }
          } finally {
            process.removeListener("SIGINT", stop);
            process.removeListener("SIGTERM", stop);
          }
        }
        console.log("Next: sliceforge task list");
      }),
    );
  queue
    .command("pause")
    .description("Prevent workers from claiming new tasks")
    .action(() =>
      action(async () => {
        (await TaskQueueEngine.open(process.cwd())).setPaused(true);
        console.log("Queue paused. Active isolated runs are not promoted or terminated.");
      }),
    );
  queue
    .command("resume")
    .description("Allow workers to claim queued tasks")
    .action(() =>
      action(async () => {
        (await TaskQueueEngine.open(process.cwd())).setPaused(false);
        console.log("Queue resumed. Next: sliceforge queue start");
      }),
    );
  queue
    .command("status")
    .description("Show queue control and task states")
    .option("--json", "emit machine-readable JSON")
    .action((options) =>
      action(async () => {
        const status = (await TaskQueueEngine.open(process.cwd())).status();
        if (options.json) return void console.log(JSON.stringify(status, null, 2));
        console.log(`Queue: ${status.control.paused ? "paused" : "running"}`);
        for (const item of status.tasks) console.log(`${item.taskId}  ${item.status}`);
        console.log(
          `Next: ${status.control.paused ? "sliceforge queue resume" : "sliceforge queue start"}`,
        );
      }),
    );

  const evaluation = program
    .command("eval")
    .description("Run repeatable model and harness regression suites");
  evaluation
    .command("run <suite>")
    .description("Execute every case, repetition and context variant")
    .option("--baseline <name>", "compare during the run")
    .action((suite, options) =>
      action(async () => {
        const engine = await evaluationEngine(process.cwd());
        const record = await engine.run(suite, options.baseline);
        console.log(`Evaluation: ${record.evaluationId}`);
        console.log(`Success:    ${(record.metrics.taskSuccessRate * 100).toFixed(1)}%`);
        console.log(`Regression: ${record.regression.passed ? "passed" : "failed"}`);
        if (record.regression.drift?.agentVersionsChanged)
          console.log(`Agent drift: ${record.regression.drift.agentVersionChanges.join("; ")}`);
        console.log(`Report:     ${new HtmlReporter(engine.store).writeEvaluation(record)}`);
        console.log(`Next:       sliceforge eval compare ${record.evaluationId}`);
        if (!record.regression.passed) process.exitCode = ExitCode.GateFailed;
      }),
    );
  evaluation
    .command("compare <runId>")
    .description("Compare evaluation metrics with a stored baseline")
    .option("--baseline <name>", "baseline name", "default")
    .action((runId, options) =>
      action(async () => {
        const result = (await evaluationEngine(process.cwd())).compare(runId, options.baseline);
        console.log(JSON.stringify(result, null, 2));
        if (!result.passed) process.exitCode = ExitCode.GateFailed;
      }),
    );
  evaluation
    .command("accept-baseline <runId>")
    .description("Store a passing evaluation as a named baseline")
    .option("--name <name>", "baseline name", "default")
    .action((runId, options) =>
      action(async () =>
        console.log((await evaluationEngine(process.cwd())).acceptBaseline(runId, options.name)),
      ),
    );

  program
    .command("run [sliceId]")
    .description("Implement and verify one slice in an isolated Git worktree")
    .action((sliceId) =>
      action(async () => printOutcome(await orchestrator.start(process.cwd(), sliceId))),
    );
  program
    .command("resume <runId>")
    .description("Recover and continue an interrupted run")
    .action((runId) =>
      action(async () => printOutcome(await orchestrator.resume(process.cwd(), runId))),
    );
  program
    .command("testgen [sliceId]")
    .description("Generate schema-validated acceptance tests in an isolated worktree")
    .action((sliceId) =>
      action(async () => printOutcome(await orchestrator.startTestGen(process.cwd(), sliceId))),
    );

  program
    .command("status")
    .description("List local SliceForge runs and their next state")
    .option("--json", "emit machine-readable JSON")
    .action((options) =>
      action(async () => {
        const runs = await orchestrator.list(process.cwd());
        if (options.json) return void console.log(JSON.stringify(runs, null, 2));
        if (!runs.length) return void console.log("No SliceForge runs yet. Next: sliceforge run");
        for (const run of runs)
          console.log(
            `${run.runId}  ${statusColor(run.status)}  ${run.kind.padEnd(14)}  ${run.sliceId}`,
          );
      }),
    );
  program
    .command("inspect <runId>")
    .description("Show a run summary and regenerate its HTML report")
    .action((runId) =>
      action(async () => printOutcome(await orchestrator.inspect(process.cwd(), runId))),
    );
  program
    .command("report <runId>")
    .description("Generate the self-contained local HTML report")
    .action((runId) =>
      action(async () => console.log(await orchestrator.reportPath(process.cwd(), runId))),
    );

  program
    .command("promote <runId>")
    .description("Cherry-pick a verified run into the original branch")
    .option("--accept-review", "explicitly accept advisory AI review findings")
    .option("--accept-attention", "explicitly accept all recorded manual/review attention items")
    .action((runId, options) =>
      action(async () => {
        const outcome = await orchestrator.promote(
          process.cwd(),
          runId,
          Boolean(options.acceptReview || options.acceptAttention),
        );
        await (await TaskQueueEngine.open(process.cwd())).syncPromoted(runId);
        printOutcome(outcome);
      }),
    );
  program
    .command("rebase <runId>")
    .description("Rebase a verified commit and rerun deterministic gates")
    .action((runId) =>
      action(async () => printOutcome(await orchestrator.rebase(process.cwd(), runId))),
    );
  program
    .command("cancel <runId>")
    .description("Cancel a run and remove its isolated worktree")
    .action((runId) =>
      action(async () => printOutcome(await orchestrator.cancel(process.cwd(), runId))),
    );
  program
    .command("clean")
    .description("Remove retained terminal runs beyond the history limit")
    .action(() =>
      action(async () => {
        const result = await orchestrator.clean(process.cwd());
        console.log(
          result.removed.length ? `Removed: ${result.removed.join(", ")}` : "Nothing to clean.",
        );
      }),
    );

  program
    .command("verify [sliceId]")
    .description("Run deterministic gates without a write-capable agent")
    .option("--ci", "non-interactive report-only mode")
    .action((sliceId) =>
      action(async () => {
        const outcome = await orchestrator.verify(process.cwd(), sliceId);
        console.log(`Verification: ${outcome.passed ? "passed" : "failed"}`);
        console.log(`Report: ${outcome.reportPath}`);
        if (!outcome.passed) process.exitCode = ExitCode.GateFailed;
      }),
    );

  return program;
}

export async function runCli(argv = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}

if (process.env.SLICEFORGE_NO_AUTO_RUN !== "1") {
  void runCli().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = ExitCode.InternalError;
  });
}
