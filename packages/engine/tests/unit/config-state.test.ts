import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { stringify as stringifyYaml } from "yaml";
import { validateProject } from "../../src/core/config-loader";
import { RuntimeStore } from "../../src/core/runtime-store";
import { TaskStore } from "../../src/core/task-engine";
import {
  validateArtifacts,
  validateChangedPaths,
  validateDocumentation,
} from "../../src/core/policy";
import { DeterministicGateRunner, deterministicGatesPassed } from "../../src/core/gate-runner";
import type {
  RunRecord,
  RunStatus,
  SliceForgeConfig,
  SliceForgePlan,
  TaskRecord,
  TaskStatus,
} from "../../src/core/contracts";

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-state-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function validConfig(): SliceForgeConfig {
  const agent = {
    type: "command" as const,
    command: process.execPath,
    args: ["--version"],
    capabilities: ["implementer" as const, "testgen" as const, "reviewer" as const],
  };
  return {
    schemaVersion: 1,
    project: "fixture",
    agents: { implementer: agent, testgen: agent, reviewer: agent },
    targets: {
      app: {
        root: ".",
        preset: "generic",
        commands: {
          unit: { command: process.execPath, args: ["-e", "process.exit(0)"] },
        },
      },
    },
    isolation: { mode: "worktree" },
    gates: {
      order: ["unit"],
      browser: { enabled: false },
      review: { enabled: false, advisory: true },
    },
    policies: { protectedPatterns: ["**/.env*"], maxRetries: 0 },
    reporting: { retainRuns: 10, maxLogBytes: 65536 },
    ci: { reportOnly: true },
  };
}

function validPlan(): SliceForgePlan {
  return {
    schemaVersion: 1,
    slices: [
      {
        id: "slice-a",
        title: "A",
        priority: 1,
        targets: ["app"],
        acceptance: [{ id: "AC-A", expected: "observable" }],
        allowedPaths: ["src/**"],
      },
    ],
  };
}

function writeProject(root: string, config = validConfig(), plan = validPlan()): void {
  fs.writeFileSync(
    path.join(root, "sliceforge.config.jsonc"),
    `// jsonc\n${JSON.stringify(config, null, 2)}`,
  );
  fs.writeFileSync(path.join(root, "sliceforge.plan.yaml"), stringifyYaml(plan));
}

describe("config and plan validation", () => {
  it("loads comments and validates a complete project", () => {
    const root = temporaryDirectory();
    writeProject(root);
    expect(validateProject(root).plan.slices[0].id).toBe("slice-a");
  });

  it("rejects duplicate JSONC keys instead of silently using the last value", () => {
    const root = temporaryDirectory();
    writeProject(root, validConfig(), validPlan());
    const configPath = path.join(root, "sliceforge.config.jsonc");
    const content = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      content.replace('"project": "fixture",', '"project": "reviewed",\n  "project": "fixture",'),
    );
    expect(() => validateProject(root)).toThrow(/Duplicate configuration key 'project'/i);
  });

  it("rejects target cycles, duplicate acceptance and path traversal", () => {
    const cycleRoot = temporaryDirectory();
    const cycleConfig = validConfig();
    cycleConfig.targets = {
      app: { root: ".", preset: "generic", dependsOn: ["lib"], commands: {} },
      lib: { root: ".", preset: "generic", dependsOn: ["app"], commands: {} },
    };
    writeProject(cycleRoot, cycleConfig);
    expect(() => validateProject(cycleRoot)).toThrow(/target dependency cycle/i);

    const duplicateRoot = temporaryDirectory();
    const duplicatePlan = validPlan();
    duplicatePlan.slices.push({
      ...duplicatePlan.slices[0],
      id: "slice-b",
      acceptance: [{ id: "AC-A", expected: "duplicate" }],
    });
    writeProject(duplicateRoot, validConfig(), duplicatePlan);
    expect(() => validateProject(duplicateRoot)).toThrow(/duplicate acceptance id/i);

    const traversalRoot = temporaryDirectory();
    const traversalPlan = validPlan();
    traversalPlan.slices[0].allowedPaths = ["../outside/**"];
    writeProject(traversalRoot, validConfig(), traversalPlan);
    expect(() => validateProject(traversalRoot)).toThrow(/escapes the project root/i);
  });

  it("rejects an invalid or excessively large runtime port range", () => {
    const reversedRoot = temporaryDirectory();
    const reversed = validConfig();
    reversed.execution = {
      concurrency: 1,
      taskTimeoutMs: 60_000,
      maxRepairAttempts: 1,
      maxRepeatedFailure: 2,
      leaseMs: 10_000,
      portRange: { start: 42_010, end: 42_000 },
    };
    writeProject(reversedRoot, reversed);
    expect(() => validateProject(reversedRoot)).toThrow(/portRange\.end/i);

    const hugeRoot = temporaryDirectory();
    const huge = validConfig();
    huge.execution = {
      ...reversed.execution,
      portRange: { start: 10_000, end: 30_000 },
    };
    writeProject(hugeRoot, huge);
    expect(() => validateProject(hugeRoot)).toThrow(/at most 10000 ports/i);
  });

  it("rejects invalid routing ranges, targets and agent capabilities", () => {
    const root = temporaryDirectory();
    const config = validConfig();
    const plan = validPlan();
    config.routing = {
      fallbackRole: "implementer",
      rules: [
        {
          role: "planner",
          targets: ["missing"],
          minComplexity: 4,
          maxComplexity: 2,
          agent: {
            type: "command",
            command: process.execPath,
            capabilities: ["reviewer"],
          },
        },
      ],
    };
    writeProject(root, config, plan);
    expect(() => validateProject(root)).toThrow(/minComplexity must not exceed maxComplexity/i);

    config.routing.rules![0].minComplexity = 1;
    config.routing.rules![0].maxComplexity = 2;
    writeProject(root, config, plan);
    expect(() => validateProject(root)).toThrow(/unknown target 'missing'/i);

    config.routing.rules![0].targets = ["app"];
    writeProject(root, config, plan);
    expect(() => validateProject(root)).toThrow(/does not declare required 'planner' capability/i);
  });

  it("rejects plans that can pass without deterministic evidence", () => {
    const root = temporaryDirectory();
    const config = validConfig();
    config.gates.order = ["review"];
    config.gates.review.enabled = true;
    writeProject(root, config);
    expect(() => validateProject(root)).toThrow(/no deterministic evidence gate/i);
    expect(deterministicGatesPassed([])).toBe(false);
  });

  it("requires explicit evidence mapping for every multi-criterion acceptance", () => {
    const root = temporaryDirectory();
    const plan = validPlan();
    plan.slices[0].acceptance.push({ id: "AC-B", expected: "second observable result" });
    writeProject(root, validConfig(), plan);
    expect(() => validateProject(root)).toThrow(/multiple acceptance.*evidence mapping/i);

    plan.slices[0].evidence = [
      { acceptanceId: "AC-A", kind: "test", source: "unit", required: true },
    ];
    writeProject(root, validConfig(), plan);
    expect(() => validateProject(root)).toThrow(/AC-B.*no required evidence/i);
  });

  it("rejects disabled or unconfigured evidence and prepare cwd traversal", () => {
    const noEvidenceRoot = temporaryDirectory();
    const noEvidenceConfig = validConfig();
    noEvidenceConfig.targets.app.commands = {};
    noEvidenceConfig.gates.order = ["browser", "review"];
    noEvidenceConfig.gates.browser.enabled = false;
    writeProject(noEvidenceRoot, noEvidenceConfig);
    expect(() => validateProject(noEvidenceRoot)).toThrow(/no deterministic evidence gate/i);

    const traversalRoot = temporaryDirectory();
    const traversalConfig = validConfig();
    traversalConfig.targets.app.prepare = {
      command: process.execPath,
      cwd: "../../outside",
    };
    writeProject(traversalRoot, traversalConfig);
    expect(() => validateProject(traversalRoot)).toThrow(/prepare\.cwd.*escapes/i);
  });

  it("requires visual configuration for visual evidence and keeps the manifest in artifacts", () => {
    const root = temporaryDirectory();
    const config = validConfig();
    config.gates.order = ["browser"];
    config.gates.browser = {
      enabled: true,
      command: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      reportPath: "artifacts/playwright.json",
    };
    const plan = validPlan();
    plan.slices[0].requiredGates = ["browser"];
    plan.slices[0].evidence = [
      { acceptanceId: "AC-A", kind: "visual", source: "browser", required: true },
    ];
    writeProject(root, config, plan);
    expect(() => validateProject(root)).toThrow(/requires visual evidence/i);

    config.gates.browser.visual = {
      artifactDirectory: "artifacts/visual",
      manifestPath: "src/visual-manifest.json",
      requiredViewports: [{ id: "desktop", width: 1280, height: 720 }],
      maxDiffRatio: 0,
      pixelThreshold: 0.1,
      maxScreenshotBytes: 1024 * 1024,
      requireNoRuntimeErrors: true,
      requireNoOverflow: true,
      requireAccessibility: true,
      requireAssets: true,
    };
    writeProject(root, config, plan);
    expect(() => validateProject(root)).toThrow(/manifestPath must be inside artifactDirectory/i);
  });
});

describe("runtime state and path policy", () => {
  function run(root: string): RunRecord {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      runId: "run-1",
      kind: "implementation",
      projectRoot: root,
      sliceId: "slice-a",
      status: "planned",
      baseBranch: "main",
      baseSha: "0".repeat(40),
      branchName: "sliceforge/slice-a/run-1",
      worktreePath: path.join(root, "worktree"),
      attempt: 0,
      createdAt: now,
      updatedAt: now,
      sequence: 0,
      priorFailures: [],
      gates: [],
      agentResponses: {},
    };
  }

  it("journals transitions and rejects invalid state changes and run-id traversal", () => {
    const root = temporaryDirectory();
    const store = new RuntimeStore({
      root,
      runs: path.join(root, "runs"),
      reports: path.join(root, "reports"),
      worktrees: path.join(root, "worktrees"),
    });
    const record = run(root);
    store.saveRun(record);
    store.transition(record, "preparing", "prepare");
    store.transition(record, "implementing", "implement");
    expect(store.readEvents(record.runId).map((event) => event.status)).toEqual([
      "preparing",
      "implementing",
    ]);
    expect(store.readEvents(record.runId).at(-1)?.data?.snapshot).toMatchObject({
      status: "implementing",
      sequence: 2,
    });
    expect(() => store.transition(record, "promoted", "skip states")).toThrow(
      /invalid run transition/i,
    );
    expect(() => store.loadRun("../outside")).toThrow(/invalid run id/i);
  });

  it("restores state from a journal entry written before a crash", () => {
    const root = temporaryDirectory();
    const store = new RuntimeStore({
      root,
      runs: path.join(root, "runs"),
      reports: path.join(root, "reports"),
      worktrees: path.join(root, "worktrees"),
    });
    const record = run(root);
    store.saveRun(record);
    const directory = store.runDirectory(record.runId);
    fs.appendFileSync(
      path.join(directory, "events.jsonl"),
      `${JSON.stringify({ sequence: 1, timestamp: new Date().toISOString(), status: "preparing", message: "crash" })}\n`,
    );
    expect(store.loadRun(record.runId)).toMatchObject({ sequence: 1, status: "preparing" });
  });

  it("restores the complete durable snapshot across every allowed run transition", () => {
    const transitions: Record<RunStatus, RunStatus[]> = {
      planned: ["preparing", "failed", "cancelled"],
      preparing: ["implementing", "validating", "failed", "cancelled"],
      implementing: ["validating", "preparing", "failed", "blocked", "cancelled"],
      validating: [
        "reviewing",
        "ready_to_promote",
        "needs_attention",
        "preparing",
        "failed",
        "blocked",
        "cancelled",
      ],
      reviewing: [
        "ready_to_promote",
        "needs_attention",
        "preparing",
        "failed",
        "blocked",
        "cancelled",
      ],
      needs_attention: ["promoting", "validating", "blocked", "cancelled"],
      ready_to_promote: ["promoting", "validating", "blocked", "cancelled"],
      promoting: ["promoted", "failed", "blocked"],
      promoted: ["promoted"],
      failed: ["preparing", "cancelled"],
      blocked: ["preparing", "validating", "cancelled"],
      cancelled: [],
    };
    const root = temporaryDirectory();
    const store = new RuntimeStore({
      root,
      runs: path.join(root, "runs"),
      reports: path.join(root, "reports"),
      worktrees: path.join(root, "worktrees"),
    });

    let index = 0;
    for (const [from, targets] of Object.entries(transitions) as Array<[RunStatus, RunStatus[]]>) {
      for (const target of targets) {
        const record = run(root);
        record.runId = `run-${index++}`;
        record.status = from;
        record.sequence = 0;
        store.saveRun(record);
        const staleState = JSON.parse(JSON.stringify(record)) as RunRecord;
        record.finalFingerprint = `${from}-to-${target}`;
        record.priorFailures = [`durable:${from}:${target}`];
        store.transition(record, target, "transition before injected crash");

        // Recreate the exact crash window: journal append completed, state rename did not.
        store.saveRun(staleState);

        expect(store.loadRun(record.runId)).toMatchObject({
          status: target,
          sequence: 1,
          finalFingerprint: `${from}-to-${target}`,
          priorFailures: [`durable:${from}:${target}`],
        });
      }
    }
  });

  it("restores complete task snapshots across every allowed task transition", () => {
    const transitions: Record<TaskStatus, TaskStatus[]> = {
      draft: ["clarifying", "ready_to_plan", "cancelled", "failed"],
      clarifying: ["clarifying", "ready_to_plan", "cancelled", "failed"],
      ready_to_plan: ["planning", "cancelled", "failed"],
      planning: ["awaiting_approval", "clarifying", "failed", "cancelled"],
      awaiting_approval: ["ready_to_plan", "queued", "clarifying", "failed", "cancelled"],
      queued: ["running", "cancelled", "blocked"],
      running: ["ready_to_promote", "needs_attention", "failed", "blocked", "cancelled"],
      needs_attention: [
        "queued",
        "ready_to_plan",
        "clarifying",
        "ready_to_promote",
        "cancelled",
        "failed",
      ],
      ready_to_promote: ["ready_to_plan", "clarifying", "promoting", "blocked", "cancelled"],
      promoting: ["promoted", "failed", "blocked"],
      promoted: ["promoted"],
      failed: ["ready_to_plan", "clarifying", "queued", "cancelled"],
      blocked: ["ready_to_plan", "clarifying", "queued", "cancelled"],
      cancelled: [],
    };
    const root = temporaryDirectory();
    const runtime = new RuntimeStore({
      root,
      runs: path.join(root, "runs"),
      tasks: path.join(root, "tasks"),
      evaluations: path.join(root, "evaluations"),
      reports: path.join(root, "reports"),
      worktrees: path.join(root, "worktrees"),
    });
    const store = new TaskStore(runtime);
    let index = 0;

    for (const [from, targets] of Object.entries(transitions) as Array<
      [TaskStatus, TaskStatus[]]
    >) {
      for (const target of targets) {
        const now = new Date().toISOString();
        const task = {
          schemaVersion: 1,
          taskId: `task-${index++}`,
          projectRoot: root,
          status: from,
          request: {
            request: "Verify durable task recovery",
            targets: ["app"],
            attachments: [],
            constraints: [],
            priority: 1,
            createdAt: now,
          },
          packet: {
            normalizedRequest: "Verify durable task recovery",
            repositoryContext: [],
            decisions: [],
            assumptions: [],
            blockers: [],
            questions: [],
            readinessScore: 100,
            contextFingerprint: "context",
          },
          runIds: [],
          evidence: [],
          revision: 1,
          createdAt: now,
          updatedAt: now,
          sequence: 0,
        } as TaskRecord;
        store.save(task);
        const staleState = JSON.parse(JSON.stringify(task)) as TaskRecord;
        task.lastError = `durable:${from}:${target}`;
        task.runIds = [`run:${from}:${target}`];
        store.transition(task, target, "transition before injected crash");

        store.save(staleState);
        expect(store.load(task.taskId)).toMatchObject({
          status: target,
          sequence: 1,
          lastError: `durable:${from}:${target}`,
          runIds: [`run:${from}:${target}`],
        });
      }
    }
  });

  it("ignores and repairs a partially written final journal record", () => {
    const root = temporaryDirectory();
    const store = new RuntimeStore({
      root,
      runs: path.join(root, "runs"),
      reports: path.join(root, "reports"),
      worktrees: path.join(root, "worktrees"),
    });
    const record = run(root);
    store.saveRun(record);
    store.transition(record, "preparing", "prepare");
    const eventPath = path.join(store.runDirectory(record.runId), "events.jsonl");
    fs.appendFileSync(eventPath, '{"sequence":2,"timestamp":');
    expect(store.readEvents(record.runId)).toHaveLength(1);
    store.transition(record, "implementing", "resume after crash");
    expect(store.readEvents(record.runId).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("blocks protected/outside paths and symlink artifacts", () => {
    expect(validateChangedPaths(["src/app.ts", ".env.local"], ["src/**"], ["**/.env*"])).toEqual([
      ".env.local: protected path",
    ]);
    expect(() => validateChangedPaths(["../outside"], ["**/*"], [])).toThrow(
      /unsafe project-relative path/i,
    );
    const root = temporaryDirectory();
    const target = path.join(root, "target.txt");
    fs.writeFileSync(target, "target");
    const link = path.join(root, "artifact.txt");
    try {
      fs.symlinkSync(target, link, "file");
      expect(validateArtifacts(root, ["artifact.txt"])).toEqual([
        "artifact.txt: symlink artifacts are not allowed",
      ]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    }
  });

  it("rejects broken, escaping and unsafe documentation links", () => {
    const root = temporaryDirectory();
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(
      path.join(root, "docs", "guide.md"),
      "[missing](./missing.md)\n[escape](../../outside.md)\n[unsafe](file:///secret.txt)\n",
    );
    expect(validateDocumentation(root, ["docs/guide.md"])).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/broken local link/),
        expect.stringMatching(/link escapes worktree/),
        expect.stringMatching(/unsafe local link/),
      ]),
    );
  });
});

describe("target-aware deterministic gates", () => {
  it("runs required target dependencies before the selected target", async () => {
    const root = temporaryDirectory();
    const config = validConfig();
    const command = { command: process.execPath, args: ["-e", "process.exit(0)"], timeoutMs: 5000 };
    config.targets = {
      lib: { root: ".", preset: "generic", commands: { unit: command } },
      app: { root: ".", preset: "generic", dependsOn: ["lib"], commands: { unit: command } },
    };
    const slice = validPlan().slices[0];
    slice.targets = ["app"];
    slice.requiredGates = ["unit"];
    const results = await new DeterministicGateRunner().run(config, slice, root);
    expect(results.map((result) => result.id)).toEqual(["slice-a:lib:unit", "slice-a:app:unit"]);
    expect(results.every((result) => result.status === "passed")).toBe(true);
  });

  it("injects the allocated runtime port into deterministic commands", async () => {
    const root = temporaryDirectory();
    const config = validConfig();
    config.targets.app.commands.integration = {
      command: process.execPath,
      args: ["-e", "process.stdout.write(process.env.SLICEFORGE_PORT || 'missing')"],
    };
    const slice = validPlan().slices[0];
    slice.requiredGates = ["integration"];
    const results = await new DeterministicGateRunner().run(config, slice, root, undefined, {
      PORT: "43123",
      SLICEFORGE_PORT: "43123",
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "passed", stdout: "43123" });
  });
});
