import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { EvaluationRecord, RunRecord, TaskRecord } from "../../src/core/contracts";
import { ExitCode } from "../../src/core/contracts";

process.env.SLICEFORGE_NO_AUTO_RUN = "1";

const mockInitializeProject = jest.fn(async () => ({ messages: ["Detected Node project."] }));
const mockLoadConfig = jest.fn(() => ({ reporting: {}, targets: { app: {} } }));
const mockLoadPlan = jest.fn(() => ({ schemaVersion: 1, slices: [] }));
const mockValidateProject = jest.fn(() => ({
  config: { targets: { app: {} } },
  plan: { slices: [{ id: "slice-a" }] },
}));
const mockRunDoctor = jest.fn(async () => ({ projectRoot: "project", checks: [], ok: true }));

const mockOrchestrator = {
  start: jest.fn(),
  resume: jest.fn(),
  startTestGen: jest.fn(),
  list: jest.fn(),
  inspect: jest.fn(),
  reportPath: jest.fn(),
  promote: jest.fn(),
  rebase: jest.fn(),
  cancel: jest.fn(),
  clean: jest.fn(),
  verify: jest.fn(),
};

const mockTaskStore = {
  list: jest.fn(),
  load: jest.fn(),
  events: jest.fn(),
};
const mockTaskEngine = {
  runtime: {},
  tasks: mockTaskStore,
  create: jest.fn(),
  answer: jest.fn(),
  approve: jest.fn(),
  revise: jest.fn(),
  cancel: jest.fn(),
};
const mockTaskEngineOpen = jest.fn(async () => mockTaskEngine);

const mockQueueEngine = {
  start: jest.fn(),
  setPaused: jest.fn(),
  status: jest.fn(),
  acceptAttention: jest.fn(),
  syncPromoted: jest.fn(),
};
const mockQueueEngineOpen = jest.fn(async () => mockQueueEngine);

const mockEvaluationEngine = {
  store: {},
  run: jest.fn(),
  compare: jest.fn(),
  acceptBaseline: jest.fn(),
};

const mockWriteDoctor = jest.fn(() => "doctor-report.html");
const mockWriteTask = jest.fn(() => "task-report.html");
const mockWriteEvaluation = jest.fn(() => "evaluation-report.html");

jest.mock("../../src/core/onboarding", () => ({ initializeProject: mockInitializeProject }));
jest.mock("../../src/core/config-loader", () => ({
  loadConfig: mockLoadConfig,
  loadPlan: mockLoadPlan,
  validateProject: mockValidateProject,
}));
jest.mock("../../src/core/doctor", () => ({ runDoctor: mockRunDoctor }));
jest.mock("../../src/core/orchestrator", () => ({
  SliceForgeOrchestrator: jest.fn(() => mockOrchestrator),
}));
jest.mock("../../src/core/task-engine", () => ({
  TaskEngine: { open: mockTaskEngineOpen },
}));
jest.mock("../../src/core/task-queue", () => ({
  TaskQueueEngine: { open: mockQueueEngineOpen },
}));
jest.mock("../../src/core/git-service", () => ({
  GitService: jest.fn(() => ({
    assertRepository: jest.fn(async () => undefined),
    commonDir: jest.fn(async () => ".git"),
  })),
}));
jest.mock("../../src/core/runtime-store", () => ({
  getRuntimePaths: jest.fn(() => ({ root: ".git/sliceforge", evaluations: "evaluations" })),
  RuntimeStore: jest.fn(() => ({})),
}));
jest.mock("../../src/core/evaluation", () => ({
  EvaluationEngine: jest.fn(() => mockEvaluationEngine),
}));
jest.mock("../../src/core/reporter", () => ({
  HtmlReporter: jest.fn(() => ({
    writeDoctor: mockWriteDoctor,
    writeTask: mockWriteTask,
    writeEvaluation: mockWriteEvaluation,
  })),
}));

const { buildProgram } = require("../../src/cli/index") as typeof import("../../src/cli/index");

const now = "2026-07-17T00:00:00.000Z";
const taskFixture = (status: TaskRecord["status"] = "awaiting_approval"): TaskRecord =>
  ({
    schemaVersion: 1,
    taskId: "task-1",
    projectRoot: "project",
    status,
    request: { request: "Create a user screen", priority: 50 },
    packet: {
      request: "Create a user screen",
      context: [],
      decisions: [],
      assumptions: [],
      unresolvedBlockers: [],
      questions: [],
      readinessScore: 90,
      contextFingerprint: "context",
    },
    runIds: [],
    evidence: [],
    revision: 1,
    createdAt: now,
    updatedAt: now,
    sequence: 1,
  }) as TaskRecord;

const runFixture = (status: RunRecord["status"]): RunRecord =>
  ({
    schemaVersion: 1,
    runId: `run-${status}`,
    kind: "implementation",
    projectRoot: "project",
    sliceId: "slice-a",
    status,
    baseBranch: "main",
    baseSha: "base",
    branchName: "candidate",
    worktreePath: "worktree",
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    sequence: 1,
    priorFailures: [],
    gates: [],
    agentResponses: {},
  }) as RunRecord;

async function runCommand(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(["node", "sliceforge", ...args], { from: "node" });
}

let logSpy: ReturnType<typeof jest.spyOn>;
let errorSpy: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.clearAllMocks();
  process.exitCode = undefined;
  logSpy = jest.spyOn(console, "log").mockImplementation(() => undefined);
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
  mockTaskEngineOpen.mockResolvedValue(mockTaskEngine);
  mockQueueEngineOpen.mockResolvedValue(mockQueueEngine);
  mockTaskStore.events.mockReturnValue([]);
  mockTaskStore.list.mockReturnValue([]);
  mockQueueEngine.status.mockReturnValue({ control: { paused: false }, tasks: [] });
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = undefined;
});

afterAll(() => {
  delete process.env.SLICEFORGE_NO_AUTO_RUN;
});

describe("CLI actions", () => {
  it("initializes projects and classifies invalid user input as a configuration error", async () => {
    await runCommand("init", "--agent", "claude", "--yes", "--force");
    expect(mockInitializeProject).toHaveBeenCalledWith(process.cwd(), {
      agent: "claude",
      yes: true,
      force: true,
    });
    expect(logSpy).toHaveBeenCalledWith("- Detected Node project.");

    await runCommand("init", "--agent", "unknown");
    expect(process.exitCode).toBe(ExitCode.ConfigurationError);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid agent 'unknown'"));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Next:   sliceforge doctor"));
  });

  it("validates plans and reports failed doctor checks with remediation", async () => {
    await runCommand("plan", "validate");
    expect(logSpy).toHaveBeenCalledWith("Plan valid: 1 slice(s), 1 target(s).");

    mockRunDoctor.mockResolvedValueOnce({
      projectRoot: "project",
      ok: false,
      checks: [
        {
          id: "git",
          status: "fail",
          message: "Git is unavailable.",
          remediation: "Install Git.",
        },
      ],
    });
    await runCommand("doctor");
    expect(process.exitCode).toBe(ExitCode.ConfigurationError);
    expect(logSpy).toHaveBeenCalledWith("FAIL  Git is unavailable.");
    expect(logSpy).toHaveBeenCalledWith("      Fix: Install Git.");
    expect(mockWriteDoctor).toHaveBeenCalled();
  });

  it("drives task intake, listing, answering, approval, revision and cancellation", async () => {
    const clarifying = taskFixture("clarifying");
    clarifying.packet.readinessScore = 45;
    clarifying.packet.questions = [
      {
        id: "expected-outcome",
        question: "What should users achieve?",
        recommendation: "Users can complete the workflow.",
        blocking: true,
      },
    ];
    mockTaskEngine.create.mockResolvedValueOnce(clarifying);
    await runCommand("do", "Build screen A", "--target", "app", "--priority", "10");
    expect(mockTaskEngine.create).toHaveBeenCalledWith(
      "Build screen A",
      expect.objectContaining({ targets: ["app"], priority: 10 }),
    );
    expect(process.exitCode).toBe(ExitCode.Blocked);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Recommended:"));

    process.exitCode = undefined;
    mockTaskStore.list.mockReturnValueOnce([taskFixture("queued")]);
    await runCommand("task", "list", "--json");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"taskId": "task-1"'));

    await runCommand("task", "answer", "task-1", "--set", "expected-outcome=Done");
    expect(mockTaskEngine.answer).toHaveBeenCalledWith("task-1", { "expected-outcome": "Done" });

    mockTaskEngine.approve.mockReturnValueOnce(taskFixture("queued"));
    await runCommand("task", "approve", "task-1");
    expect(logSpy).toHaveBeenCalledWith("Next:      sliceforge queue start");

    mockTaskEngine.revise.mockResolvedValueOnce(taskFixture("awaiting_approval"));
    await runCommand("task", "revise", "task-1", "--feedback", "Use a compact table");
    expect(mockTaskEngine.revise).toHaveBeenCalledWith("task-1", "Use a compact table");

    mockTaskEngine.cancel.mockReturnValueOnce(taskFixture("cancelled"));
    await runCommand("task", "cancel", "task-1");
    expect(mockTaskEngine.cancel).toHaveBeenCalledWith("task-1");
  });

  it("controls queue state and maps queue failures to gate exit codes", async () => {
    mockQueueEngine.start.mockResolvedValueOnce({
      processed: ["task-1"],
      readyToPromote: [],
      failed: ["task-1"],
    });
    await runCommand("queue", "start", "--concurrency", "2");
    expect(mockQueueEngine.start).toHaveBeenCalledWith(2);
    expect(process.exitCode).toBe(ExitCode.GateFailed);

    process.exitCode = undefined;
    await runCommand("queue", "pause");
    expect(mockQueueEngine.setPaused).toHaveBeenCalledWith(true);
    await runCommand("queue", "resume");
    expect(mockQueueEngine.setPaused).toHaveBeenCalledWith(false);

    mockQueueEngine.status.mockReturnValueOnce({
      control: { paused: true },
      tasks: [{ taskId: "task-1", status: "queued" }],
    });
    await runCommand("queue", "status");
    expect(logSpy).toHaveBeenCalledWith("Queue: paused");
    expect(logSpy).toHaveBeenCalledWith("Next: sliceforge queue resume");
  });

  it("runs evaluation commands and exposes provenance drift and regression failures", async () => {
    const evaluation = {
      evaluationId: "evaluation-1",
      metrics: { taskSuccessRate: 0.5 },
      regression: {
        passed: false,
        reasons: ["A trial failed."],
        drift: {
          agentVersionsChanged: true,
          agentVersionChanges: ["planner: v1 -> v2"],
          configChanged: false,
          contextChanged: false,
        },
      },
    } as EvaluationRecord;
    mockEvaluationEngine.run.mockResolvedValueOnce(evaluation);
    await runCommand("eval", "run", "suite.json", "--baseline", "default");
    expect(mockEvaluationEngine.run).toHaveBeenCalledWith("suite.json", "default");
    expect(logSpy).toHaveBeenCalledWith("Agent drift: planner: v1 -> v2");
    expect(process.exitCode).toBe(ExitCode.GateFailed);

    process.exitCode = undefined;
    mockEvaluationEngine.compare.mockReturnValueOnce({ passed: true, reasons: [] });
    await runCommand("eval", "compare", "evaluation-1", "--baseline", "stable");
    expect(mockEvaluationEngine.compare).toHaveBeenCalledWith("evaluation-1", "stable");

    mockEvaluationEngine.acceptBaseline.mockReturnValueOnce("baseline.json");
    await runCommand("eval", "accept-baseline", "evaluation-1", "--name", "stable");
    expect(logSpy).toHaveBeenCalledWith("baseline.json");
  });

  it("maps low-level run outcomes, promotion, cleanup and CI verification", async () => {
    mockOrchestrator.start.mockResolvedValueOnce({
      run: runFixture("ready_to_promote"),
      reportPath: "run-report.html",
    });
    await runCommand("run", "slice-a");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("sliceforge promote run-ready_to_promote"),
    );

    mockOrchestrator.inspect.mockResolvedValueOnce({
      run: runFixture("needs_attention"),
      reportPath: "attention.html",
    });
    await runCommand("inspect", "run-needs_attention");
    expect(process.exitCode).toBe(ExitCode.Blocked);

    process.exitCode = undefined;
    mockOrchestrator.promote.mockResolvedValueOnce({
      run: runFixture("promoted"),
      reportPath: "promoted.html",
    });
    await runCommand("promote", "run-ready", "--accept-attention");
    expect(mockOrchestrator.promote).toHaveBeenCalledWith(process.cwd(), "run-ready", true);
    expect(mockQueueEngine.syncPromoted).toHaveBeenCalledWith("run-ready");

    mockOrchestrator.clean.mockResolvedValueOnce({ removed: ["old-run"] });
    await runCommand("clean");
    expect(logSpy).toHaveBeenCalledWith("Removed: old-run");

    mockOrchestrator.verify.mockResolvedValueOnce({ passed: false, reportPath: "verify.html" });
    await runCommand("verify", "slice-a", "--ci");
    expect(process.exitCode).toBe(ExitCode.GateFailed);
    expect(logSpy).toHaveBeenCalledWith("Verification: failed");
  });
});
