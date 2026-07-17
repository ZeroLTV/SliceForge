import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { runProcess } from "../../src/core/process-runner";
import {
  AgentProtocolRunner,
  createAgentRequest,
  createPlanningAgentRequest,
} from "../../src/core/agent-protocol";
import type {
  AgentDefinition,
  AgentResponse,
  PlanningAgentRole,
  SliceDefinition,
} from "../../src/core/contracts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-process-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  delete process.env.SLICEFORGE_TEST_SECRET;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("process runner", () => {
  it("rejects cwd traversal before spawning", async () => {
    const result = await runProcess(
      { command: process.execPath, args: ["--version"], cwd: "../outside" },
      { root: temporaryDirectory() },
    );
    expect(result.exitCode).toBe(-1);
    expect(result.stderr).toMatch(/escapes the worktree/);
  });

  it("inherits only allowlisted environment and redacts secrets", async () => {
    const root = temporaryDirectory();
    process.env.SLICEFORGE_TEST_SECRET = "super-secret-value";
    const hidden = await runProcess(
      {
        command: process.execPath,
        args: ["-e", "console.log(process.env.SLICEFORGE_TEST_SECRET || 'missing')"],
      },
      { root },
    );
    expect(hidden.stdout.trim()).toBe("missing");

    const exposed = await runProcess(
      {
        command: process.execPath,
        args: ["-e", "console.log(process.env.SLICEFORGE_TEST_SECRET)"],
        envAllowlist: ["SLICEFORGE_TEST_SECRET"],
      },
      { root, secrets: ["super-secret-value"] },
    );
    expect(exposed.stdout).toContain("[REDACTED]");
    expect(exposed.stdout).not.toContain("super-secret-value");
    expect(exposed.sensitiveOutputDetected).toBe(true);
  });

  it("times out a long-running child", async () => {
    const result = await runProcess(
      { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 100 },
      { root: temporaryDirectory() },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBe(true);
  });

  it("kills descendants when a command times out", async () => {
    const root = temporaryDirectory();
    const marker = path.join(root, "descendant-survived.txt");
    const descendant = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'alive'), 800)`;
    const parent = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
    const result = await runProcess(
      { command: process.execPath, args: ["-e", parent], timeoutMs: 100 },
      { root },
    );
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(result.timedOut).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("keeps a bounded prefix without killing a successful high-output process", async () => {
    const result = await runProcess(
      {
        command: process.execPath,
        args: ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024))"],
      },
      { root: temporaryDirectory(), maxOutputBytes: 4096 },
    );
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThan(4300);
    expect(result.stdout).toContain("output truncated by SliceForge");
  });

  it("resolves the canonical Gradle wrapper on the current platform", async () => {
    const root = temporaryDirectory();
    if (process.platform === "win32") {
      fs.writeFileSync(path.join(root, "gradlew.bat"), "@echo off\r\necho portable-wrapper\r\n");
    } else {
      const wrapper = path.join(root, "gradlew");
      fs.writeFileSync(wrapper, "#!/bin/sh\nprintf portable-wrapper\n");
      fs.chmodSync(wrapper, 0o755);
    }
    const result = await runProcess({ command: "./gradlew" }, { root });
    expect(result).toMatchObject({ exitCode: 0, failedToStart: false });
    expect(result.stdout).toContain("portable-wrapper");
  });
});

describe("generic agent protocol", () => {
  const slice: SliceDefinition = {
    id: "protocol",
    title: "Protocol contract",
    priority: 1,
    targets: ["app"],
    acceptance: [{ id: "AC-1", expected: "A strict response" }],
    allowedPaths: ["src/**"],
  };

  const request = (cwd: string) =>
    createAgentRequest("run-1", "implementer", cwd, slice, {
      readOnly: false,
      allowedPaths: slice.allowedPaths,
      artifacts: [],
      priorFailures: [],
    });

  function definition(stdoutExpression: string) {
    return {
      type: "command" as const,
      command: process.execPath,
      args: [
        "-e",
        `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(${stdoutExpression}))`,
      ],
      capabilities: ["implementer" as const],
    };
  }

  it("accepts exactly one complete schema-valid JSON response", async () => {
    const response: AgentResponse = {
      protocolVersion: "1.0",
      status: "completed",
      summary: "done",
      artifacts: [],
      commandsRun: [],
      diagnostics: [],
    };
    await expect(
      new AgentProtocolRunner().run(
        definition(JSON.stringify(JSON.stringify(response))),
        request(temporaryDirectory()),
        65536,
      ),
    ).resolves.toEqual(response);
  });

  it("injects engine-owned runtime environment into the agent process", async () => {
    const runtimeRequest = createAgentRequest(
      "run-port",
      "implementer",
      temporaryDirectory(),
      slice,
      {
        readOnly: false,
        allowedPaths: slice.allowedPaths,
        artifacts: [],
        priorFailures: [],
        environment: { PORT: "43123", SLICEFORGE_PORT: "43123" },
      },
    );
    const responseExpression = `JSON.stringify({protocolVersion:"1.0",status:"completed",summary:process.env.SLICEFORGE_PORT,artifacts:[],commandsRun:[],diagnostics:[]})`;
    await expect(
      new AgentProtocolRunner().run(definition(responseExpression), runtimeRequest, 65536),
    ).resolves.toMatchObject({ summary: "43123" });
  });

  it("rejects an invalid outbound request before starting the agent process", async () => {
    const root = temporaryDirectory();
    const marker = path.join(root, "agent-started.txt");
    const invalid = request(root) as unknown as {
      constraints: { allowedPaths: unknown[] };
    };
    invalid.constraints.allowedPaths = [42];
    await expect(
      new AgentProtocolRunner().run(
        {
          type: "command",
          command: process.execPath,
          args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
          capabilities: ["implementer"],
        },
        invalid as never,
        65_536,
      ),
    ).rejects.toThrow(/Agent request schema validation failed/i);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.each([
    ["partial JSON", '\'{"protocolVersion":"1.0"\''],
    [
      "duplicate key",
      '\'{"protocolVersion":"1.0","status":"completed","status":"failed","summary":"x","artifacts":[],"commandsRun":[],"diagnostics":[]}\'',
    ],
    [
      "unknown field",
      '\'{"protocolVersion":"1.0","status":"completed","summary":"x","artifacts":[],"commandsRun":[],"diagnostics":[],"trusted":true}\'',
    ],
    [
      "invalid diagnostic",
      '\'{"protocolVersion":"1.0","status":"completed","summary":"x","artifacts":[],"commandsRun":[],"diagnostics":[{"severity":"critical","message":"x"}]}\'',
    ],
  ])("rejects %s", async (_name, expression) => {
    await expect(
      new AgentProtocolRunner().run(definition(expression), request(temporaryDirectory()), 65536),
    ).rejects.toThrow();
  });
});

describe("built-in agent adapter contracts", () => {
  const slice: SliceDefinition = {
    id: "adapter",
    title: "Adapter contract",
    priority: 1,
    targets: ["app"],
    acceptance: [{ id: "ADAPTER-1", expected: "protocol response" }],
    allowedPaths: ["src/**"],
  };

  function adapterExecutable(root: string): string {
    const script = path.join(root, "adapter.cjs");
    fs.writeFileSync(
      script,
      `let input="";process.stdin.on("data",chunk=>input+=chunk);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({protocolVersion:"1.0",status:"completed",summary:JSON.stringify({args:process.argv.slice(2),prompt:input.includes("SLICEFORGE_RESPONSE_JSON="),configHome:Boolean(process.env.HOME||process.env.USERPROFILE||process.env.LOCALAPPDATA)}),artifacts:[],commandsRun:[],diagnostics:[]})));`,
    );
    if (process.platform === "win32") {
      const wrapper = path.join(root, "adapter.cmd");
      fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
      return wrapper;
    }
    const wrapper = path.join(root, "adapter");
    fs.writeFileSync(
      wrapper,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    );
    fs.chmodSync(wrapper, 0o755);
    return wrapper;
  }

  it.each([
    ["codex", false, ["exec", "--model", "model-x", "--full-auto", "-"]],
    ["codex", true, ["exec", "--model", "model-x", "--sandbox", "read-only", "-"]],
    ["claude", false, ["-p", "--model", "model-x", "--output-format", "json"]],
    [
      "claude",
      true,
      ["-p", "--model", "model-x", "--output-format", "json", "--permission-mode", "plan"],
    ],
    ["cursor", false, ["-p", "--model", "model-x", "--force"]],
    ["cursor", true, ["-p", "--model", "model-x"]],
  ] as const)(
    "constructs %s readOnly=%s arguments and protocol prompt",
    async (type, readOnly, args) => {
      const root = temporaryDirectory();
      const response = await new AgentProtocolRunner().run(
        { type, command: adapterExecutable(root), model: "model-x" } as AgentDefinition,
        createAgentRequest(`run-${type}-${readOnly}`, "implementer", root, slice, {
          readOnly,
          allowedPaths: slice.allowedPaths,
          artifacts: [],
          priorFailures: [],
        }),
        65_536,
      );
      expect(JSON.parse(response.summary)).toEqual({ args, prompt: true, configHome: true });
    },
  );
});

describe("structured planning agent protocol", () => {
  const task = {
    id: "task-1",
    request: "Create a verified user API and UI workflow.",
    targets: ["app"],
    constraints: [],
    priority: 1,
    attachments: [],
    createdAt: new Date(0).toISOString(),
  };

  function definition(role: PlanningAgentRole, response: unknown) {
    return {
      type: "command" as const,
      command: process.execPath,
      args: [
        "-e",
        `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify(response))}))`,
      ],
      capabilities: [role],
    };
  }

  function request(role: PlanningAgentRole, proposal: unknown, cwd: string) {
    return createPlanningAgentRequest("task-1", role, cwd, {
      task,
      constraints: {
        readOnly: true,
        maxQuestions: 3,
        allowedTargets: ["app"],
        targetRoots: { app: "." },
      },
      context: {
        project: "fixture",
        documentation: [],
        repositoryContext: [],
        targetGates: { app: ["unit"] },
        proposal: proposal as never,
      },
    });
  }

  it("accepts role-specific clarifier and planner outputs", async () => {
    const clarifierOutput = {
      kind: "clarification" as const,
      readinessScore: 90,
      questions: [],
      assumptions: [],
      blockers: [],
    };
    const clarifierResponse: AgentResponse = {
      protocolVersion: "1.0",
      status: "completed",
      summary: "Task is ready",
      artifacts: [],
      commandsRun: [],
      diagnostics: [],
      output: clarifierOutput,
    };
    await expect(
      new AgentProtocolRunner().run(
        definition("clarifier", clarifierResponse),
        request("clarifier", clarifierOutput, temporaryDirectory()),
        65536,
      ),
    ).resolves.toEqual(clarifierResponse);

    const plannerOutput = {
      kind: "plan" as const,
      slices: [
        {
          id: "api",
          title: "Implement API",
          priority: 1,
          targets: ["app"],
          acceptance: [{ id: "API-1", expected: "API behavior is verified" }],
          allowedPaths: ["src/api/**"],
          requiredGates: ["unit" as const],
          evidence: [
            { acceptanceId: "API-1", kind: "test" as const, source: "unit", required: true },
          ],
        },
      ],
      assumptions: [],
      risks: [],
    };
    const plannerResponse: AgentResponse = {
      protocolVersion: "1.0",
      status: "completed",
      summary: "Plan ready",
      artifacts: [],
      commandsRun: [],
      diagnostics: [],
      output: plannerOutput,
    };
    await expect(
      new AgentProtocolRunner().run(
        definition("planner", plannerResponse),
        request("planner", plannerOutput, temporaryDirectory()),
        65536,
      ),
    ).resolves.toEqual(plannerResponse);
  });

  it.each([
    [
      "non-blocking clarifier question",
      "clarifier" as const,
      {
        kind: "clarification",
        readinessScore: 50,
        questions: [{ id: "scope", question: "Scope?", recommendation: "Use app." }],
        assumptions: [],
        blockers: [],
      },
    ],
    [
      "empty planner graph",
      "planner" as const,
      { kind: "plan", slices: [], assumptions: [], risks: [] },
    ],
  ])("rejects %s", async (_name, role, output) => {
    const response = {
      protocolVersion: "1.0",
      status: "completed",
      summary: "invalid",
      artifacts: [],
      commandsRun: [],
      diagnostics: [],
      output,
    };
    await expect(
      new AgentProtocolRunner().run(
        definition(role, response),
        request(role, output, temporaryDirectory()),
        65536,
      ),
    ).rejects.toThrow();
  });
});
