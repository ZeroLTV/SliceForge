import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import type { RunRecord, TaskRecord } from "../../src/core/contracts";
import { HtmlReporter } from "../../src/core/reporter";
import { RuntimeStore } from "../../src/core/runtime-store";

const roots: string[] = [];

function runtime(): { root: string; store: RuntimeStore } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-report-"));
  roots.push(root);
  const runtimeRoot = path.join(root, "runtime-private");
  return {
    root,
    store: new RuntimeStore({
      root: runtimeRoot,
      runs: path.join(runtimeRoot, "runs"),
      tasks: path.join(runtimeRoot, "tasks"),
      evaluations: path.join(runtimeRoot, "evaluations"),
      reports: path.join(runtimeRoot, "reports"),
      worktrees: path.join(root, "worktrees-private"),
    }),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("HTML report privacy", () => {
  it("omits repository snippets and replaces attachment and project paths", () => {
    const { root, store } = runtime();
    const now = new Date().toISOString();
    const inputPath = path.join(root, "private-inputs", "screen.png");
    const storedPath = path.join(store.paths.root, "tasks", "task-1", "attachments", "image.png");
    const task = {
      schemaVersion: 1,
      taskId: "task-1",
      projectRoot: root,
      status: "awaiting_approval",
      request: {
        id: "task-1",
        request: "Build the screen",
        targets: ["app"],
        constraints: [],
        priority: 1,
        attachments: [
          {
            id: "image-1",
            kind: "image",
            source: inputPath,
            storedPath,
            sha256: "abc",
            sizeBytes: 3,
          },
        ],
        createdAt: now,
      },
      packet: {
        request: {} as never,
        contextFingerprint: "context",
        contextSummary: {
          project: "fixture",
          targets: ["app"],
          targetRoots: { app: "." },
          documentation: [],
          files: [
            {
              path: "src/private.ts",
              kind: "api-schema",
              sha256: "def",
              sizeBytes: 30,
              snippet: "REPORT_CONTEXT_SECRET_MUST_NOT_LEAK",
            },
          ],
        },
        readinessScore: 100,
        assumptions: [],
        decisions: [],
        blockers: [],
        questions: [],
      },
      graph: {
        taskId: "task-1",
        revision: 1,
        slices: [
          {
            id: "screen",
            title: "Screen",
            description: `References: ${inputPath} and ${storedPath}`,
            priority: 1,
            targets: ["app"],
            acceptance: [{ id: "AC-1", expected: "Screen exists" }],
            allowedPaths: ["src/**"],
            requiredGates: ["unit"],
          },
        ],
        evidence: [],
        assumptions: [],
        risks: [],
        fingerprint: "graph",
      },
      planningAgentResponses: {
        planner: {
          protocolVersion: 1,
          status: "completed",
          summary: "planned",
          artifacts: [],
          commandsRun: ["PLANNER_COMMAND_HISTORY_MUST_NOT_LEAK"],
          diagnostics: [{ severity: "info", message: "secret=planner-secret" }],
          output: {
            kind: "plan",
            slices: [],
            assumptions: ["PLANNER_CONTEXT_SECRET_MUST_NOT_LEAK"],
            risks: [],
          },
        },
      },
      runIds: [],
      evidence: [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
      sequence: 0,
    } as TaskRecord;
    task.packet.request = task.request;

    const html = fs.readFileSync(new HtmlReporter(store).writeTask(task, []), "utf8");
    expect(html).not.toContain(root);
    expect(html).not.toContain(root.replace(/\\/g, "/"));
    expect(html).not.toContain(root.replace(/\\/g, "\\\\"));
    expect(html).not.toContain(inputPath);
    expect(html).not.toContain(storedPath);
    expect(html).not.toContain("REPORT_CONTEXT_SECRET_MUST_NOT_LEAK");
    expect(html).not.toContain("PLANNER_COMMAND_HISTORY_MUST_NOT_LEAK");
    expect(html).not.toContain("PLANNER_CONTEXT_SECRET_MUST_NOT_LEAK");
    expect(html).not.toContain("planner-secret");
    expect(html).toContain("$INPUT_PATH");
    expect(html).toContain("$ATTACHMENT_PATH");
  });

  it("keeps bounded agent summaries but omits command history and redacts diagnostics", () => {
    const { root, store } = runtime();
    const now = new Date().toISOString();
    const worktree = path.join(root, "worktrees-private", "run-1");
    const run = {
      schemaVersion: 1,
      runId: "run-1",
      kind: "implementation",
      projectRoot: root,
      sliceId: "slice-1",
      status: "ready_to_promote",
      baseBranch: "main",
      baseSha: "0".repeat(40),
      branchName: "sliceforge/slice-1/run-1",
      worktreePath: worktree,
      attempt: 1,
      createdAt: now,
      updatedAt: now,
      sequence: 0,
      priorFailures: [],
      gates: [],
      agentResponses: {
        implementer: {
          protocolVersion: 1,
          status: "completed",
          summary: `Completed in ${worktree}`,
          artifacts: [],
          commandsRun: ["REPORT_COMMAND_HISTORY_MUST_NOT_LEAK"],
          diagnostics: [{ severity: "info", message: "password=super-secret-value" }],
        },
      },
    } as RunRecord;
    store.saveRun(run);

    const html = fs.readFileSync(new HtmlReporter(store).writeRun(run), "utf8");
    expect(html).not.toContain(root);
    expect(html).not.toContain(root.replace(/\\/g, "\\\\"));
    expect(html).not.toContain("REPORT_COMMAND_HISTORY_MUST_NOT_LEAK");
    expect(html).not.toContain("super-secret-value");
    expect(html).toContain("$WORKTREE");
    expect(html).toContain("password=[REDACTED]");
  });
});
