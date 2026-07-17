import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { stringify as stringifyYaml } from "yaml";
import { SliceForgeOrchestrator } from "../../src/core/orchestrator";
import { GitService } from "../../src/core/git-service";
import { getRuntimePaths, RuntimeStore } from "../../src/core/runtime-store";
import { sliceGraphFingerprint, TaskEngine } from "../../src/core/task-engine";
import { TaskQueueEngine } from "../../src/core/task-queue";
import { getPortAllocatorDataRoot, PortAllocator } from "../../src/core/port-allocator";
import type {
  SliceDefinition,
  SliceForgeConfig,
  SliceForgePlan,
  TaskRecord,
} from "../../src/core/contracts";

const repositories: string[] = [];
jest.setTimeout(120000);

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-git-"));
  repositories.push(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "sliceforge@example.invalid");
  git(root, "config", "user.name", "SliceForge Test");

  const agentPath = path.join(root, "fixture-agent.cjs");
  fs.writeFileSync(
    agentPath,
    `
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const artifact = request.constraints.requiredArtifacts[0] || ("result-" + request.slice.id + ".txt");
  if (request.slice.id === "slow-change") {
    setInterval(() => {}, 1000);
    return;
  }
  if (request.role === "reviewer") {
    if (request.slice.id === "reviewer-candidate-mutation") {
      const crypto = require("crypto");
      const os = require("os");
      const path = require("path");
      const repoKey = crypto.createHash("sha256").update(path.resolve(__dirname)).digest("hex").slice(0, 16);
      const candidate = path.join(os.tmpdir(), "sliceforge-worktrees", repoKey, request.runId, "result.txt");
      require("fs").appendFileSync(candidate, "candidate mutation\\n");
    } else {
      require("fs").appendFileSync(require("path").join(request.cwd, "result.txt"), "review mutation\\n");
    }
  } else {
    require("fs").mkdirSync(require("path").dirname(require("path").join(request.cwd, artifact)), { recursive: true });
    require("fs").writeFileSync(require("path").join(request.cwd, artifact), "verified output\\n");
    if (request.slice.id === "ignored-artifact") {
      require("fs").writeFileSync(require("path").join(request.cwd, "source.txt"), "candidate source\\n");
    }
  }
  process.stdout.write(JSON.stringify({ protocolVersion: "1.0", status: "completed", summary: "artifact created", artifacts: artifact ? [artifact] : [], commandsRun: [], diagnostics: [] }));
});
`,
  );
  const agent = {
    type: "command" as const,
    command: process.execPath,
    args: [agentPath],
    capabilities: ["implementer" as const, "testgen" as const, "reviewer" as const],
  };
  const config: SliceForgeConfig = {
    schemaVersion: 1,
    project: "git-fixture",
    agents: { implementer: agent, testgen: agent, reviewer: agent },
    targets: { app: { root: ".", preset: "generic", commands: {} } },
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
    reporting: { retainRuns: 10, maxLogBytes: 65536 },
    ci: { reportOnly: true },
  };
  const plan: SliceForgePlan = {
    schemaVersion: 1,
    slices: [
      {
        id: "isolated-change",
        title: "Create a verified result",
        priority: 1,
        targets: ["app"],
        acceptance: [{ id: "AC-1", expected: "result.txt exists" }],
        allowedPaths: ["result.txt"],
        requiredArtifacts: ["result.txt"],
        requiredGates: ["artifact"],
      },
    ],
  };
  fs.writeFileSync(path.join(root, "sliceforge.config.jsonc"), JSON.stringify(config, null, 2));
  fs.writeFileSync(path.join(root, "sliceforge.plan.yaml"), stringifyYaml(plan));
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "fixture base");
  return root;
}

function addDependentSlice(
  tasks: TaskEngine,
  task: TaskRecord,
): {
  first: SliceDefinition;
  second: SliceDefinition;
  secondArtifact: string;
} {
  const first = task.graph!.slices[0];
  const secondArtifact = `docs/specs/${first.id}-second.md`;
  const second: SliceDefinition = {
    ...first,
    id: `${first.id}-second`,
    title: "Create the dependent second result",
    dependsOn: [first.id],
    acceptance: [{ id: `${first.id.toUpperCase()}-AC-002`, expected: "second artifact exists" }],
    requiredArtifacts: [secondArtifact],
    evidence: [
      {
        acceptanceId: `${first.id.toUpperCase()}-AC-002`,
        kind: "artifact",
        source: secondArtifact,
        required: true,
      },
    ],
  };
  task.graph!.slices.push(second);
  task.graph!.evidence.push(...second.evidence!);
  task.graph!.fingerprint = sliceGraphFingerprint(task.graph!);
  tasks.tasks.save(task);
  return { first, second, secondArtifact };
}

afterEach(() => {
  for (const root of repositories.splice(0)) {
    try {
      git(root, "worktree", "prune");
    } catch {
      /* Repository may already be unavailable. */
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("worktree orchestration with real Git", () => {
  it("routes the implementer by target and complexity inside a real isolated run", async () => {
    const root = createRepository();
    const routedAgent = path.join(root, "routed-agent.cjs");
    fs.writeFileSync(
      routedAgent,
      `let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>{const request=JSON.parse(input);const fs=require("fs");const path=require("path");const artifact=request.constraints.requiredArtifacts[0];fs.writeFileSync(path.join(request.cwd,artifact),"routed implementer\\n");process.stdout.write(JSON.stringify({protocolVersion:"1.0",status:"completed",summary:"routed",artifacts:[artifact],commandsRun:[],diagnostics:[]}));});`,
    );
    const configPath = path.join(root, "sliceforge.config.jsonc");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as SliceForgeConfig;
    config.routing = {
      fallbackRole: "implementer",
      rules: [
        {
          role: "implementer",
          targets: ["app"],
          minComplexity: 1,
          agent: {
            type: "command",
            command: process.execPath,
            args: [routedAgent],
            capabilities: ["implementer"],
          },
        },
      ],
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    git(root, "add", "sliceforge.config.jsonc", "routed-agent.cjs");
    git(root, "commit", "-m", "configure routed implementer");

    const orchestrator = new SliceForgeOrchestrator();
    const outcome = await orchestrator.start(root, "isolated-change");
    expect(outcome.run.status).toBe("ready_to_promote");
    expect(fs.readFileSync(path.join(outcome.run.worktreePath, "result.txt"), "utf8")).toBe(
      "routed implementer\n",
    );
    expect(outcome.run.agentResponses.implementer?.summary).toBe("routed");
    await orchestrator.cancel(root, outcome.run.runId);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("requires attention when a public surface changes without documentation", async () => {
    const root = createRepository();
    const planPath = path.join(root, "sliceforge.plan.yaml");
    const plan: SliceForgePlan = {
      schemaVersion: 1,
      slices: [
        {
          id: "public-cli-change",
          title: "Add a public CLI command",
          priority: 1,
          targets: ["app"],
          acceptance: [{ id: "CLI-001", expected: "public CLI artifact exists" }],
          allowedPaths: ["src/cli/**"],
          requiredArtifacts: ["src/cli/new-command.ts"],
          requiredGates: ["artifact"],
          docsImpact: "review",
          evidence: [
            {
              acceptanceId: "CLI-001",
              kind: "artifact",
              source: "src/cli/new-command.ts",
              required: true,
            },
          ],
        },
      ],
    };
    fs.writeFileSync(planPath, stringifyYaml(plan));
    git(root, "add", "sliceforge.plan.yaml");
    git(root, "commit", "-m", "add public CLI slice");

    const orchestrator = new SliceForgeOrchestrator();
    const outcome = await orchestrator.start(root, "public-cli-change");
    expect(outcome.run.status).toBe("needs_attention");
    expect(outcome.run.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "public-cli-change:docs-impact",
          status: "warning",
          summary: expect.stringMatching(/Public surface changed without documentation/i),
        }),
      ]),
    );
    await orchestrator.cancel(root, outcome.run.runId);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("runs the do-to-queue golden path without touching the original tree", async () => {
    const root = createRepository();
    const originalHead = git(root, "rev-parse", "HEAD");
    const tasks = await TaskEngine.open(root);
    const planned = await tasks.create(
      "Allow the user to create a local result file, write expected content when the workflow runs, and verify completion with an artifact test.",
    );
    expect(planned.status).toBe("awaiting_approval");
    tasks.approve(planned.taskId);

    const queue = await TaskQueueEngine.open(root);
    const result = await queue.start(1);
    expect(result).toMatchObject({
      processed: [planned.taskId],
      readyToPromote: [planned.taskId],
      failed: [],
    });
    const ready = tasks.tasks.load(planned.taskId);
    expect(ready.status).toBe("ready_to_promote");
    expect(ready.evidence.every((item) => item.status === "verified")).toBe(true);
    expect(git(root, "rev-parse", "HEAD")).toBe(originalHead);
    expect(git(root, "status", "--porcelain")).toBe("");

    const runId = ready.execution!.bundleRunId!;
    await new SliceForgeOrchestrator().promote(root, runId);
    await queue.syncPromoted(runId);
    expect(tasks.tasks.load(planned.taskId).status).toBe("promoted");
    expect(git(root, "rev-parse", "HEAD")).not.toBe(originalHead);
  });

  it("integrates a dependent multi-slice graph into one verified bundle", async () => {
    const root = createRepository();
    const originalHead = git(root, "rev-parse", "HEAD");
    const tasks = await TaskEngine.open(root);
    const task = await tasks.create(
      "Allow the user to create staged local result files, write expected content when each workflow runs, and verify completion with artifact tests.",
    );
    const { first, second, secondArtifact } = addDependentSlice(tasks, task);
    tasks.approve(task.taskId);

    const result = await (await TaskQueueEngine.open(root)).start(1);
    const ready = tasks.tasks.load(task.taskId);
    expect(ready.lastError).toBeUndefined();
    expect({ result, status: ready.status, lastError: ready.lastError }).toMatchObject({
      result: { readyToPromote: [task.taskId], failed: [] },
      status: "ready_to_promote",
    });
    expect(ready.execution?.integratedSliceIds).toEqual([first.id, second.id]);
    expect(ready.evidence.every((item) => item.status === "verified")).toBe(true);
    expect(git(root, "rev-parse", "HEAD")).toBe(originalHead);
    expect(fs.existsSync(path.join(root, first.requiredArtifacts![0]))).toBe(false);
    expect(fs.existsSync(path.join(root, secondArtifact))).toBe(false);

    await new SliceForgeOrchestrator().promote(root, ready.execution!.bundleRunId!);
    expect(fs.existsSync(path.join(root, first.requiredArtifacts![0]))).toBe(true);
    expect(fs.existsSync(path.join(root, secondArtifact))).toBe(true);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("rebases and revalidates every slice in a task bundle after HEAD drift", async () => {
    const root = createRepository();
    const tasks = await TaskEngine.open(root);
    const task = await tasks.create(
      "Allow the user to create staged local result files, write expected content when each workflow runs, and verify completion with artifact tests.",
    );
    const { first, secondArtifact } = addDependentSlice(tasks, task);
    tasks.approve(task.taskId);
    await (await TaskQueueEngine.open(root)).start(1);
    const ready = tasks.tasks.load(task.taskId);
    const runId = ready.execution!.bundleRunId!;
    const orchestrator = new SliceForgeOrchestrator();
    const beforeRebase = await orchestrator.inspect(root, runId);

    fs.writeFileSync(path.join(root, "unrelated.txt"), "advanced base\n");
    git(root, "add", "unrelated.txt");
    git(root, "commit", "-m", "advance original head");
    await expect(orchestrator.promote(root, runId)).rejects.toThrow(/HEAD changed/i);

    const rebased = await orchestrator.rebase(root, runId);
    expect(rebased.run.status).toBe("ready_to_promote");
    expect(rebased.run.gates.length).toBeGreaterThanOrEqual(beforeRebase.run.gates.length + 2);
    expect(rebased.run.acceptanceCoverage?.map((item) => item.status)).toEqual([
      "verified",
      "verified",
    ]);
    await orchestrator.promote(root, runId);
    expect(fs.existsSync(path.join(root, first.requiredArtifacts![0]))).toBe(true);
    expect(fs.existsSync(path.join(root, secondArtifact))).toBe(true);
    expect(fs.readFileSync(path.join(root, "unrelated.txt"), "utf8")).toBe("advanced base\n");
  });

  it("recovers a slice promoted to task staging before integration state was recorded", async () => {
    const root = createRepository();
    const tasks = await TaskEngine.open(root);
    const task = await tasks.create(
      "Allow the user to create a local result file, write expected content when the workflow runs, and verify completion with an artifact test.",
    );
    tasks.approve(task.taskId);
    const queue = await TaskQueueEngine.open(root);
    const internals = queue as unknown as {
      markIntegrated(taskId: string, sliceId: string): Promise<void>;
    };
    const markIntegrated = internals.markIntegrated.bind(queue);
    let injected = false;
    internals.markIntegrated = async (taskId, sliceId) => {
      if (!injected) {
        injected = true;
        throw new Error("simulated crash before integration state update");
      }
      await markIntegrated(taskId, sliceId);
    };

    expect((await queue.start(1)).failed).toEqual([task.taskId]);
    const crashed = tasks.tasks.load(task.taskId);
    expect(crashed.execution?.pendingRunId).toBeDefined();
    expect(
      (
        await new SliceForgeOrchestrator().inspect(
          crashed.execution!.stagingWorktreePath,
          crashed.execution!.pendingRunId!,
        )
      ).run.status,
    ).toBe("promoted");
    tasks.tasks.transition(
      crashed,
      "queued",
      "Simulated worker restart after durable crash state.",
    );

    const recovered = await (await TaskQueueEngine.open(root)).start(1);
    const ready = tasks.tasks.load(task.taskId);
    expect(recovered.readyToPromote).toEqual([task.taskId]);
    expect(ready.execution?.pendingRunId).toBeUndefined();
    expect(ready.execution?.integratedSliceIds).toEqual([task.graph!.slices[0].id]);
    expect(ready.status).toBe("ready_to_promote");
  });

  it("rediscovers a registered bundle after a crash and cleans stale staging", async () => {
    const root = createRepository();
    const tasks = await TaskEngine.open(root);
    const task = await tasks.create(
      "Allow the user to create a local result file, write expected content when the workflow runs, and verify completion with an artifact test.",
    );
    tasks.approve(task.taskId);
    const queue = await TaskQueueEngine.open(root);
    const internals = queue as unknown as {
      recordBundleRun(taskId: string, runId: string): Promise<void>;
    };
    const recordBundleRun = internals.recordBundleRun.bind(queue);
    let injected = false;
    internals.recordBundleRun = async (taskId, runId) => {
      if (!injected) {
        injected = true;
        throw new Error("simulated crash before bundle state update");
      }
      await recordBundleRun(taskId, runId);
    };

    expect((await queue.start(1)).failed).toEqual([task.taskId]);
    const crashed = tasks.tasks.load(task.taskId);
    const stagingPath = crashed.execution!.stagingWorktreePath;
    const bundleRunsBefore = (await new SliceForgeOrchestrator().list(root)).filter(
      (run) => run.kind === "task" && run.sliceId === `task:${task.taskId}`,
    );
    expect(bundleRunsBefore).toHaveLength(1);
    expect(crashed.execution?.bundleRunId).toBeUndefined();
    tasks.tasks.transition(
      crashed,
      "queued",
      "Simulated worker restart after durable crash state.",
    );

    const recovered = await (await TaskQueueEngine.open(root)).start(1);
    const ready = tasks.tasks.load(task.taskId);
    const bundleRunsAfter = (await new SliceForgeOrchestrator().list(root)).filter(
      (run) => run.kind === "task" && run.sliceId === `task:${task.taskId}`,
    );
    expect(recovered.readyToPromote).toEqual([task.taskId]);
    expect(ready.execution?.bundleRunId).toBe(bundleRunsBefore[0].runId);
    expect(bundleRunsAfter).toHaveLength(1);
    expect(fs.existsSync(stagingPath)).toBe(false);
  });

  it("never promotes unverified evidence but permits explicit manual evidence", async () => {
    const root = createRepository();
    const orchestrator = new SliceForgeOrchestrator();
    const unverified = await orchestrator.startDefinition(root, {
      id: "unverified-evidence",
      title: "Do not promote missing evidence",
      priority: 1,
      targets: ["app"],
      acceptance: [{ id: "UNVERIFIED-1", expected: "a unit test proves behavior" }],
      allowedPaths: ["unverified.txt"],
      requiredArtifacts: ["unverified.txt"],
      requiredGates: ["artifact"],
      evidence: [{ acceptanceId: "UNVERIFIED-1", kind: "test", source: "unit", required: true }],
    });
    expect(unverified.run.status).toBe("needs_attention");
    expect(unverified.run.acceptanceCoverage?.[0].status).toBe("unverified");
    await expect(orchestrator.promote(root, unverified.run.runId, true)).rejects.toThrow(
      /unverified acceptance evidence/i,
    );

    const manual = await orchestrator.startDefinition(root, {
      id: "manual-evidence",
      title: "Require a human decision",
      priority: 1,
      targets: ["app"],
      acceptance: [{ id: "MANUAL-1", expected: "a human accepts the generated artifact" }],
      allowedPaths: ["manual.txt"],
      requiredArtifacts: ["manual.txt"],
      requiredGates: ["artifact"],
      evidence: [{ acceptanceId: "MANUAL-1", kind: "manual", source: "human", required: true }],
    });
    expect(manual.run.acceptanceCoverage?.[0].status).toBe("manual_required");
    await expect(orchestrator.promote(root, manual.run.runId)).rejects.toThrow(
      /explicit human acceptance/i,
    );
    await expect(orchestrator.promote(root, manual.run.runId, true)).resolves.toMatchObject({
      run: { status: "promoted" },
    });
  });

  it("prevents promotion of a run superseded by task revision", async () => {
    const root = createRepository();
    const tasks = await TaskEngine.open(root);
    const planned = await tasks.create(
      "Allow the user to create a local result file, write expected content when the workflow runs, and verify completion with an artifact test.",
    );
    tasks.approve(planned.taskId);
    await (await TaskQueueEngine.open(root)).start(1);
    const ready = tasks.tasks.load(planned.taskId);
    const oldRunId = ready.execution!.bundleRunId!;
    const revised = await tasks.revise(ready.taskId, "Use a different output contract.");
    expect(revised.supersededRunIds).toContain(oldRunId);
    expect(revised.runIds).toEqual([]);
    await expect(new SliceForgeOrchestrator().promote(root, oldRunId, true)).rejects.toThrow(
      /superseded/i,
    );
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("serializes concurrent queue tasks that share a target resource", async () => {
    const root = createRepository();
    const tasks = await TaskEngine.open(root);
    const first = await tasks.create(
      "Allow the user to create a first local result file, write expected content when the workflow runs, and verify completion with an artifact test.",
    );
    const second = await tasks.create(
      "Allow the user to create a second local result file, write expected content when the workflow runs, and verify completion with an artifact test.",
    );
    tasks.approve(first.taskId);
    tasks.approve(second.taskId);
    const result = await (await TaskQueueEngine.open(root)).start(2);
    expect(result.readyToPromote).toHaveLength(2);

    const firstEvents = tasks.tasks.events(first.taskId);
    const secondEvents = tasks.tasks.events(second.taskId);
    const firstReady = firstEvents.find((event) => event.status === "ready_to_promote")!;
    const secondRunning = secondEvents.find((event) => event.status === "running")!;
    expect(Date.parse(secondRunning.timestamp)).toBeGreaterThanOrEqual(
      Date.parse(firstReady.timestamp),
    );
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("runs network tasks on different targets concurrently with unique port leases", async () => {
    const root = createRepository();
    const configPath = path.join(root, "sliceforge.config.jsonc");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as SliceForgeConfig;
    const integration = {
      command: process.execPath,
      args: [
        "-e",
        "setTimeout(()=>process.stdout.write(process.env.SLICEFORGE_PORT || 'missing'),1500)",
      ],
    };
    config.targets.app.commands.integration = integration;
    config.targets.worker = { root: ".", preset: "generic", commands: { integration } };
    config.execution = {
      concurrency: 2,
      taskTimeoutMs: 60_000,
      maxRepairAttempts: 1,
      maxRepeatedFailure: 2,
      leaseMs: 10_000,
      portRange: { start: 45_000, end: 45_100 },
      portEnv: ["PORT", "SLICEFORGE_PORT"],
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    git(root, "add", "sliceforge.config.jsonc", "fixture-agent.cjs");
    git(root, "commit", "-m", "configure network targets");

    const tasks = await TaskEngine.open(root);
    const first = await tasks.create(
      "Allow users to create a first network result; when the integration workflow runs, then the integration test must verify the result.",
      { targets: ["app"] },
    );
    const second = await tasks.create(
      "Allow users to create a second network result; when the integration workflow runs, then the integration test must verify the result.",
      { targets: ["worker"] },
    );
    tasks.approve(first.taskId);
    tasks.approve(second.taskId);
    const result = await (await TaskQueueEngine.open(root)).start(2);
    const firstReady = tasks.tasks.load(first.taskId);
    const secondReady = tasks.tasks.load(second.taskId);
    if (result.failed.length) {
      throw new Error(
        JSON.stringify(
          [firstReady, secondReady].map((task) => ({
            taskId: task.taskId,
            status: task.status,
            lastError: task.lastError,
            execution: task.execution,
          })),
          null,
          2,
        ),
      );
    }
    expect({
      result,
      tasks: [firstReady, secondReady].map((task) => ({
        taskId: task.taskId,
        status: task.status,
        lastError: task.lastError,
      })),
    }).toMatchObject({
      result: { readyToPromote: expect.arrayContaining([first.taskId, second.taskId]), failed: [] },
      tasks: [
        { taskId: first.taskId, status: "ready_to_promote" },
        { taskId: second.taskId, status: "ready_to_promote" },
      ],
    });
    const firstRun = tasks.runtime.loadRun(firstReady.runIds[0]);
    const secondRun = tasks.runtime.loadRun(secondReady.runIds[0]);
    expect(firstRun.runtimeEnv?.PORT).toMatch(/^45\d{3}$/);
    expect(secondRun.runtimeEnv?.PORT).toMatch(/^45\d{3}$/);
    expect(firstRun.runtimeEnv?.PORT).not.toBe(secondRun.runtimeEnv?.PORT);
    expect(firstRun.gates.find((gate) => gate.kind === "integration")?.stdout).toBe(
      firstRun.runtimeEnv?.PORT,
    );
    expect(secondRun.gates.find((gate) => gate.kind === "integration")?.stdout).toBe(
      secondRun.runtimeEnv?.PORT,
    );
    const firstBundle = tasks.runtime.loadRun(firstReady.execution!.bundleRunId!);
    const secondBundle = tasks.runtime.loadRun(secondReady.execution!.bundleRunId!);
    expect(firstBundle.runtimeEnv?.PORT).toMatch(/^45\d{3}$/);
    expect(secondBundle.runtimeEnv?.PORT).toMatch(/^45\d{3}$/);
    expect(firstBundle.gates.find((gate) => gate.kind === "integration")?.stdout).toBe(
      firstBundle.runtimeEnv?.PORT,
    );
    expect(secondBundle.gates.find((gate) => gate.kind === "integration")?.stdout).toBe(
      secondBundle.runtimeEnv?.PORT,
    );

    const firstReadyEvent = tasks.tasks
      .events(first.taskId)
      .find((event) => event.status === "ready_to_promote")!;
    const secondRunningEvent = tasks.tasks
      .events(second.taskId)
      .find((event) => event.status === "running")!;
    expect(Date.parse(secondRunningEvent.timestamp)).toBeLessThan(
      Date.parse(firstReadyEvent.timestamp),
    );
    const remainingLeases = await new PortAllocator(
      getPortAllocatorDataRoot(),
      45_000,
      45_100,
    ).list();
    expect(
      remainingLeases.filter(
        (lease) => lease.owner.includes(first.taskId) || lease.owner.includes(second.taskId),
      ),
    ).toEqual([]);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("parses porcelain v2 rename/Unicode and fingerprints deletions", async () => {
    const root = createRepository();
    const service = new GitService(root);
    const renamed = "docs/ten co dau - d\u1eef li\u1ec7u.txt";
    fs.mkdirSync(path.join(root, "docs"));
    git(root, "mv", "README.md", renamed);
    const status = await service.status();
    expect(status).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: renamed, originalPath: "README.md" }),
      ]),
    );
    await expect(service.fingerprint(git(root, "rev-parse", "HEAD"), root)).resolves.toMatch(
      /^[a-f0-9]{64}$/,
    );
  });

  it("recreates a missing worktree and branch from the recorded base SHA", async () => {
    const root = createRepository();
    const service = new GitService(root);
    const worktree = path.join(
      os.tmpdir(),
      `sliceforge-recovery-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    await service.restoreWorktree(worktree, "sliceforge/recovery/run", await service.head());
    expect(await service.head(worktree)).toBe(await service.head());
    await service.removeWorktree(worktree, true);
    await service.deleteBranch("sliceforge/recovery/run");
  });

  it("includes dangling untracked symlinks in sanitized diff evidence", async () => {
    const root = createRepository();
    const link = path.join(root, "dangling-link.txt");
    try {
      fs.symlinkSync("missing-target.txt", link, "file");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }
    const diff = await new GitService(root).diff(git(root, "rev-parse", "HEAD"), root);
    expect(diff).toContain("new file mode 120000");
    expect(diff).toContain("+missing-target.txt");
  });

  it("does not mutate the original tree before explicit promote", async () => {
    const root = createRepository();
    const originalHead = git(root, "rev-parse", "HEAD");
    const outcome = await new SliceForgeOrchestrator().start(root, "isolated-change");

    expect(outcome.run.status).toBe("ready_to_promote");
    expect(fs.existsSync(path.join(root, "result.txt"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
    expect(git(root, "rev-parse", "HEAD")).toBe(originalHead);
    expect(fs.existsSync(path.join(outcome.run.worktreePath, "result.txt"))).toBe(true);

    const promoted = await new SliceForgeOrchestrator().promote(root, outcome.run.runId);
    expect(promoted.run.status).toBe("promoted");
    expect(fs.readFileSync(path.join(root, "result.txt"), "utf8").replace(/\r\n/g, "\n")).toBe(
      "verified output\n",
    );
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("blocks HEAD drift, then rebase reruns gates before promote", async () => {
    const root = createRepository();
    const orchestrator = new SliceForgeOrchestrator();
    const outcome = await orchestrator.start(root, "isolated-change");
    fs.writeFileSync(path.join(root, "unrelated.txt"), "new base\n");
    git(root, "add", "unrelated.txt");
    git(root, "commit", "-m", "advance original head");

    await expect(orchestrator.promote(root, outcome.run.runId)).rejects.toThrow(/rebase/i);
    const blocked = await orchestrator.inspect(root, outcome.run.runId);
    expect(blocked.run.status).toBe("blocked");
    expect(fs.existsSync(path.join(root, "result.txt"))).toBe(false);

    const rebased = await orchestrator.rebase(root, outcome.run.runId);
    expect(rebased.run.status).toBe("ready_to_promote");
    expect(rebased.run.gates.filter((gate) => gate.kind === "artifact")).toHaveLength(2);
    await orchestrator.promote(root, outcome.run.runId);
    expect(fs.existsSync(path.join(root, "result.txt"))).toBe(true);
    expect(fs.existsSync(path.join(root, "unrelated.txt"))).toBe(true);
  });

  it("recovers a completed promotion with branch, parent and tree proof", async () => {
    const root = createRepository();
    const orchestrator = new SliceForgeOrchestrator();
    const outcome = await orchestrator.start(root, "isolated-change");
    const service = new GitService(root);
    const store = new RuntimeStore(getRuntimePaths(root, await service.commonDir()));
    const run = store.loadRun(outcome.run.runId);
    store.transition(run, "promoting", "inject crash after cherry-pick");
    git(root, "cherry-pick", run.commitSha!);

    const recovered = await orchestrator.resume(root, run.runId);
    expect(recovered.run.status).toBe("promoted");
    expect(recovered.run.promotedSha).toBe(git(root, "rev-parse", "HEAD"));
    expect(fs.existsSync(path.join(root, "result.txt"))).toBe(true);
  });

  it("blocks promotion from a different branch even at the same SHA", async () => {
    const root = createRepository();
    const orchestrator = new SliceForgeOrchestrator();
    const outcome = await orchestrator.start(root, "isolated-change");
    git(root, "checkout", "-b", "other-branch");
    await expect(orchestrator.promote(root, outcome.run.runId)).rejects.toThrow(/checkout 'main'/i);
    expect((await orchestrator.inspect(root, outcome.run.runId)).run.status).toBe("blocked");
    expect(fs.existsSync(path.join(root, "result.txt"))).toBe(false);
    await orchestrator.cancel(root, outcome.run.runId);
  });

  it("rejects reviewer mutation and keeps evidence outside the original tree", async () => {
    const root = createRepository();
    const configPath = path.join(root, "sliceforge.config.jsonc");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as SliceForgeConfig;
    config.gates.review.enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const planPath = path.join(root, "sliceforge.plan.yaml");
    const plan = stringifyYaml({
      schemaVersion: 1,
      slices: [
        {
          id: "isolated-change",
          title: "Create a verified result",
          priority: 1,
          targets: ["app"],
          acceptance: [{ id: "AC-1", expected: "result.txt exists" }],
          allowedPaths: ["result.txt"],
          requiredArtifacts: ["result.txt"],
          requiredGates: ["artifact", "review"],
        },
      ],
    });
    fs.writeFileSync(planPath, plan);
    git(root, "add", "sliceforge.config.jsonc", "sliceforge.plan.yaml");
    git(root, "commit", "-m", "enable reviewer fixture");

    const outcome = await new SliceForgeOrchestrator().start(root, "isolated-change");
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.priorFailures.join("\n")).toMatch(/reviewer mutated/i);
    expect(outcome.run.sanitizedDiff).toContain("verified output");
    expect(outcome.run.policyViolations).toContain("reviewer wrote result.txt");
    expect(fs.existsSync(path.join(root, "result.txt"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("detects reviewer mutation of the candidate even when HEAD is unchanged", async () => {
    const root = createRepository();
    const configPath = path.join(root, "sliceforge.config.jsonc");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as SliceForgeConfig;
    config.gates.review.enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const planPath = path.join(root, "sliceforge.plan.yaml");
    fs.writeFileSync(
      planPath,
      stringifyYaml({
        schemaVersion: 1,
        slices: [
          {
            id: "reviewer-candidate-mutation",
            title: "Reject candidate mutation",
            priority: 1,
            targets: ["app"],
            acceptance: [{ id: "REVIEW-1", expected: "candidate remains immutable" }],
            allowedPaths: ["result.txt"],
            requiredArtifacts: ["result.txt"],
            requiredGates: ["artifact", "review"],
          },
        ],
      }),
    );
    git(root, "add", "sliceforge.config.jsonc", "sliceforge.plan.yaml");
    git(root, "commit", "-m", "configure candidate mutation fixture");

    const outcome = await new SliceForgeOrchestrator().start(root, "reviewer-candidate-mutation");
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.policyViolations).toContain("reviewer mutated the candidate worktree");
    expect(fs.existsSync(path.join(root, "result.txt"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("verify is report-only and never invokes a write-capable agent", async () => {
    const root = createRepository();
    const outcome = await new SliceForgeOrchestrator().verify(root, "isolated-change");
    expect(outcome.passed).toBe(false);
    expect(fs.existsSync(path.join(root, "result.txt"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("runs CI gates in a disposable worktree and reports gate mutation", async () => {
    const root = createRepository();
    const configPath = path.join(root, "sliceforge.config.jsonc");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as SliceForgeConfig;
    config.targets.app.commands.unit = {
      command: process.execPath,
      args: ["-e", "require('fs').writeFileSync('ci-mutated.txt', 'x')"],
    };
    config.gates.order = ["unit"];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    const planPath = path.join(root, "sliceforge.plan.yaml");
    fs.writeFileSync(
      planPath,
      stringifyYaml({
        schemaVersion: 1,
        slices: [
          {
            id: "ci-check",
            title: "CI mutation check",
            priority: 1,
            targets: ["app"],
            acceptance: [{ id: "CI-1", expected: "gate is isolated" }],
            allowedPaths: ["source.txt"],
            requiredGates: ["unit"],
          },
        ],
      }),
    );
    git(root, "add", "sliceforge.config.jsonc", "sliceforge.plan.yaml");
    git(root, "commit", "-m", "configure mutating CI gate");
    const outcome = await new SliceForgeOrchestrator().verify(root, "ci-check");
    expect(outcome.passed).toBe(false);
    expect(outcome.gates.at(-1)?.summary).toMatch(/mutated immutable input/i);
    expect(fs.existsSync(path.join(root, "ci-mutated.txt"))).toBe(false);
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("rejects an ignored required artifact before validation", async () => {
    const root = createRepository();
    fs.writeFileSync(path.join(root, ".gitignore"), "result.txt\n");
    const planPath = path.join(root, "sliceforge.plan.yaml");
    fs.writeFileSync(
      planPath,
      stringifyYaml({
        schemaVersion: 1,
        slices: [
          {
            id: "ignored-artifact",
            title: "Ignored artifact",
            priority: 1,
            targets: ["app"],
            acceptance: [{ id: "IGN-1", expected: "ignored evidence is rejected" }],
            allowedPaths: ["result.txt", "source.txt"],
            requiredArtifacts: ["result.txt"],
            requiredGates: ["artifact"],
          },
        ],
      }),
    );
    git(root, "add", ".gitignore", "sliceforge.plan.yaml");
    git(root, "commit", "-m", "configure ignored artifact");
    const outcome = await new SliceForgeOrchestrator().start(root, "ignored-artifact");
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.priorFailures.join("\n")).toMatch(/artifact is ignored/i);
    expect(fs.existsSync(path.join(root, "source.txt"))).toBe(false);
  });

  it("cannot bypass unpromoted slice dependencies with an explicit id", async () => {
    const root = createRepository();
    const planPath = path.join(root, "sliceforge.plan.yaml");
    fs.writeFileSync(
      planPath,
      stringifyYaml({
        schemaVersion: 1,
        slices: [
          {
            id: "base-slice",
            title: "Base",
            priority: 1,
            targets: ["app"],
            acceptance: [{ id: "DEP-1", expected: "base promoted" }],
            allowedPaths: ["result.txt"],
            requiredArtifacts: ["result.txt"],
            requiredGates: ["artifact"],
          },
          {
            id: "dependent-slice",
            title: "Dependent",
            priority: 2,
            dependsOn: ["base-slice"],
            targets: ["app"],
            acceptance: [{ id: "DEP-2", expected: "dependency enforced" }],
            allowedPaths: ["result.txt"],
            requiredArtifacts: ["result.txt"],
            requiredGates: ["artifact"],
          },
        ],
      }),
    );
    git(root, "add", "sliceforge.plan.yaml");
    git(root, "commit", "-m", "add dependent slices");
    await expect(new SliceForgeOrchestrator().start(root, "dependent-slice")).rejects.toThrow(
      /unpromoted dependencies: base-slice/i,
    );
  });

  it("cancels an active agent process through the run cancellation channel", async () => {
    const root = createRepository();
    const planPath = path.join(root, "sliceforge.plan.yaml");
    fs.writeFileSync(
      planPath,
      stringifyYaml({
        schemaVersion: 1,
        slices: [
          {
            id: "slow-change",
            title: "Slow change",
            priority: 1,
            targets: ["app"],
            acceptance: [{ id: "CANCEL-1", expected: "run can be stopped" }],
            allowedPaths: ["result.txt"],
            requiredArtifacts: ["result.txt"],
            requiredGates: ["artifact"],
          },
        ],
      }),
    );
    git(root, "add", "sliceforge.plan.yaml");
    git(root, "commit", "-m", "add cancellable slice");
    const orchestrator = new SliceForgeOrchestrator();
    const running = orchestrator.start(root, "slow-change");
    let runId: string | undefined;
    for (let attempt = 0; attempt < 80 && !runId; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      runId = (await orchestrator.list(root))[0]?.runId;
    }
    expect(runId).toBeDefined();
    const cancelled = await orchestrator.cancel(root, runId!);
    const outcome = await running;
    expect(cancelled.run.status).toBe("cancelled");
    expect(outcome.run.status).toBe("cancelled");
  });
});
