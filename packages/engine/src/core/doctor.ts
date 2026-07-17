import * as fs from "fs";
import * as path from "path";
import type {
  AgentDefinition,
  AgentRole,
  DoctorCheck,
  DoctorReport,
  SliceForgeConfig,
  SliceForgePlan,
} from "./contracts.js";
import { GitService } from "./git-service.js";
import { getPortAllocatorDataRoot, PortAllocator } from "./port-allocator.js";
import { runProcess } from "./process-runner.js";

function agentCommand(agent: AgentDefinition): { command: string; args: string[] } {
  if (agent.type === "command") return { command: agent.command!, args: ["--version"] };
  if (agent.type === "codex") return { command: agent.command ?? "codex", args: ["--version"] };
  if (agent.type === "claude") return { command: agent.command ?? "claude", args: ["--version"] };
  return { command: agent.command ?? "cursor-agent", args: ["--version"] };
}

const VERSION_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TMP",
  "TEMP",
  "TMPDIR",
];

export async function runDoctor(
  projectRoot: string,
  config: SliceForgeConfig,
  plan: SliceForgePlan,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const git = new GitService(projectRoot);
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    nodeMajor >= 20
      ? { id: "runtime.node", status: "pass", message: `Node.js ${process.versions.node}.` }
      : {
          id: "runtime.node",
          status: "fail",
          message: `Node.js ${process.versions.node} is unsupported.`,
          remediation: "Install Node.js 20 LTS or newer.",
        },
  );
  try {
    fs.accessSync(projectRoot, fs.constants.R_OK | fs.constants.W_OK);
    checks.push({
      id: "filesystem.project",
      status: "pass",
      message: "Project root is readable and writable.",
    });
  } catch {
    checks.push({
      id: "filesystem.project",
      status: "fail",
      message: "Project root is not readable and writable.",
      remediation: "Fix filesystem permissions before initialization or execution.",
    });
  }
  try {
    await git.assertRepository();
    checks.push({ id: "git.repository", status: "pass", message: "Git repository detected." });
    checks.push(
      (await git.isClean())
        ? { id: "git.clean", status: "pass", message: "Original working tree is clean." }
        : {
            id: "git.clean",
            status: "fail",
            message: "Original working tree has uncommitted changes.",
            remediation: "Commit or stash changes before running a slice.",
          },
    );
    const identity = await Promise.all(
      ["user.name", "user.email"].map((key) =>
        runProcess(
          { command: "git", args: ["config", "--get", key], timeoutMs: 5000 },
          { root: projectRoot, maxOutputBytes: 4096 },
        ),
      ),
    );
    checks.push(
      identity.every((result) => result.exitCode === 0 && result.stdout.trim())
        ? { id: "git.identity", status: "pass", message: "Git commit identity is configured." }
        : {
            id: "git.identity",
            status: "fail",
            message: "Git user.name or user.email is missing.",
            remediation:
              "Configure Git commit identity before SliceForge creates verified commits.",
          },
    );
  } catch (err) {
    checks.push({
      id: "git.repository",
      status: "fail",
      message: err instanceof Error ? err.message : String(err),
      remediation: "Initialize Git and create an initial commit.",
    });
  }

  const testedAgents = new Set<string>();
  const configuredAgents = [
    ...Object.entries(config.agents).map(([role, agent]) => ({
      role,
      agent,
      path: `agents.${role}`,
    })),
    ...(config.routing?.rules ?? []).map((rule, index) => ({
      role: rule.role,
      agent: rule.agent,
      path: `routing.rules[${index}].agent`,
    })),
  ];
  for (const { role, agent, path: configPath } of configuredAgents) {
    if (agent.type === "command" && !agent.capabilities?.includes(role as AgentRole)) {
      checks.push({
        id: `agent.${role}.capability`,
        status: "fail",
        message: `Generic agent for '${role}' does not declare that capability.`,
        remediation: `Add '${role}' to ${configPath}.capabilities or configure a different agent.`,
      });
    }
    const executable = agentCommand(agent);
    const key = `${executable.command}\0${executable.args.join("\0")}`;
    if (testedAgents.has(key)) continue;
    testedAgents.add(key);
    const result = await runProcess(
      {
        command: executable.command,
        args: executable.args,
        timeoutMs: 10000,
        envAllowlist: VERSION_ENV,
      },
      { root: projectRoot, maxOutputBytes: 16384 },
    );
    checks.push(
      result.exitCode === 0
        ? {
            id: `agent.${role}`,
            status: "pass",
            message: `${executable.command}: ${(result.stdout || result.stderr).trim()}`,
          }
        : {
            id: `agent.${role}`,
            status: "fail",
            message: `Agent executable '${executable.command}' is unavailable or invalid.`,
            remediation: `Install it or update ${configPath} in sliceforge.config.jsonc.`,
          },
    );
  }

  const portRange = config.execution?.portRange ?? { start: 41_000, end: 41_999 };
  const allocator = new PortAllocator(getPortAllocatorDataRoot(), portRange.start, portRange.end);
  const doctorOwner = `doctor:${process.pid}:${Date.now()}`;
  try {
    const lease = await allocator.acquire(doctorOwner, 5_000);
    await allocator.release(doctorOwner);
    checks.push({
      id: "execution.port-allocator",
      status: "pass",
      message: `Machine-wide runtime port allocator is writable; port ${lease.port} is available.`,
    });
  } catch (error) {
    checks.push({
      id: "execution.port-allocator",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
      remediation:
        "Choose an available execution.portRange and ensure the SliceForge OS application-data directory is writable.",
    });
  }

  if (config.inputs?.figmaProvider) {
    const provider = await runProcess(
      {
        command: config.inputs.figmaProvider.command,
        args: ["--version"],
        timeoutMs: 10_000,
        envAllowlist: VERSION_ENV,
      },
      { root: projectRoot, maxOutputBytes: 16_384 },
    );
    checks.push(
      provider.failedToStart
        ? {
            id: "input.figma-provider",
            status: "fail",
            message: `Figma context provider '${config.inputs.figmaProvider.command}' could not be started.`,
            remediation: "Install the provider or remove inputs.figmaProvider; Figma is optional.",
          }
        : {
            id: "input.figma-provider",
            status: provider.exitCode === 0 ? "pass" : "warn",
            message: "Configured Figma context provider is available.",
          },
    );
  } else {
    checks.push({
      id: "input.figma-provider",
      status: "warn",
      message:
        "No Figma context provider is configured; local text and image inputs remain available.",
      remediation: "Configure inputs.figmaProvider only when Figma intake is needed.",
    });
  }

  const testedExecutables = new Set<string>();
  for (const [name, target] of Object.entries(config.targets)) {
    const root = path.resolve(projectRoot, target.root);
    checks.push(
      fs.existsSync(root)
        ? {
            id: `target.${name}`,
            status: "pass",
            message: `${name}: ${target.preset} at ${target.root}`,
          }
        : {
            id: `target.${name}`,
            status: "fail",
            message: `Target root does not exist: ${target.root}`,
          },
    );
    for (const [gate, command] of Object.entries({
      prepare: target.prepare,
      ...target.commands,
    })) {
      if (!command) continue;
      if (command?.shell) {
        checks.push({
          id: `command.${name}.${gate}.shell`,
          status: "warn",
          message: `${name}.${gate} uses shell execution.`,
          remediation: "Prefer command + args for portable, injection-resistant execution.",
        });
      }
      if (!testedExecutables.has(command.command)) {
        testedExecutables.add(command.command);
        const version = await runProcess(
          {
            command: command.command,
            args: ["--version"],
            cwd: target.root,
            timeoutMs: 10000,
            envAllowlist: VERSION_ENV,
          },
          { root: projectRoot, maxOutputBytes: 16384 },
        );
        checks.push(
          version.failedToStart
            ? {
                id: `executable.${command.command}`,
                status: "fail",
                message: `Required executable '${command.command}' could not be started.`,
                remediation: `Install '${command.command}' and ensure it is available on PATH.`,
              }
            : {
                id: `executable.${command.command}`,
                status: version.exitCode === 0 ? "pass" : "warn",
                message:
                  version.exitCode === 0
                    ? `${command.command}: ${(version.stdout || version.stderr).trim().split(/\r?\n/, 1)[0]}`
                    : `${command.command} is available but did not accept --version.`,
              },
        );
      }
      for (const [key, value] of Object.entries(command.env ?? {})) {
        if (/token|secret|password|passwd|api.?key/i.test(key) && value.length > 0) {
          checks.push({
            id: `secret.${name}.${gate}.${key}`,
            status: "fail",
            message: `${name}.${gate} stores a likely secret in command.env (${key}).`,
            remediation: `Remove the value and inherit ${key} explicitly through envAllowlist.`,
          });
        }
      }
    }
    if (target.preset === "python" && !target.prepare) {
      checks.push({
        id: `prepare.${name}`,
        status: "warn",
        message: `${name} has no isolated dependency preparation command.`,
        remediation:
          "Configure target.prepare to create an isolated environment before validation.",
      });
    }
    if (target.health) {
      try {
        const url = new URL(target.health.url);
        if (!(["http:", "https:"] as string[]).includes(url.protocol)) {
          throw new Error("unsupported health URL protocol");
        }
        checks.push({
          id: `health.${name}`,
          status: "pass",
          message: `${name} health URL is valid (${url.origin}).`,
        });
      } catch {
        checks.push({
          id: `health.${name}`,
          status: "fail",
          message: `${name} has an invalid health URL.`,
          remediation: "Use an absolute http:// or https:// URL.",
        });
      }
    }
  }

  const dependencyClosure = (names: string[]): string[] => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const visit = (name: string): void => {
      if (seen.has(name)) return;
      for (const dependency of config.targets[name].dependsOn ?? []) visit(dependency);
      seen.add(name);
      ordered.push(name);
    };
    for (const name of names) visit(name);
    return ordered;
  };
  for (const slice of plan.slices) {
    const enabled = new Set(slice.requiredGates ?? config.gates.order);
    for (const kind of ["build", "lint", "unit", "integration", "e2e"] as const) {
      if (!enabled.has(kind)) continue;
      for (const targetName of dependencyClosure(slice.targets)) {
        if (!config.targets[targetName].commands[kind]) {
          checks.push({
            id: `plan.${slice.id}.${targetName}.${kind}`,
            status: "fail",
            message: `Slice '${slice.id}' requires ${kind}, but target '${targetName}' has no command.`,
            remediation: `Configure targets.${targetName}.commands.${kind} or remove it from the slice only if equivalent deterministic evidence exists.`,
          });
        }
      }
    }
  }

  if (
    config.gates.browser.enabled &&
    (!config.gates.browser.command || !config.gates.browser.reportPath)
  ) {
    checks.push({
      id: "browser.command",
      status: "fail",
      message: "Browser gate is enabled without a deterministic command and JSON report path.",
      remediation:
        "Configure gates.browser.command and gates.browser.reportPath for the Playwright JSON reporter.",
    });
  } else if (config.gates.browser.enabled && config.gates.browser.command) {
    const browserExecutable = await runProcess(
      {
        command: config.gates.browser.command.command,
        args: ["--version"],
        timeoutMs: 10000,
        envAllowlist: VERSION_ENV,
      },
      { root: projectRoot, maxOutputBytes: 16384 },
    );
    if (browserExecutable.failedToStart) {
      checks.push({
        id: "browser.executable",
        status: "fail",
        message: `Browser executable '${config.gates.browser.command.command}' could not be started.`,
        remediation: "Install Playwright and its browser binary before enabling browser gates.",
      });
    }
  }
  const visual = config.gates.browser.visual;
  if (visual?.baselineDirectory) {
    const missing = visual.requiredViewports
      .map((viewport) => path.join(projectRoot, visual.baselineDirectory!, `${viewport.id}.png`))
      .filter((baseline) => !fs.existsSync(baseline) || !fs.lstatSync(baseline).isFile());
    checks.push(
      missing.length
        ? {
            id: "browser.visual-baselines",
            status: "fail",
            message: `Missing visual baseline(s): ${missing.map((item) => path.relative(projectRoot, item)).join(", ")}.`,
            remediation:
              "Review and commit a PNG baseline for every required viewport before enabling regression comparison.",
          }
        : {
            id: "browser.visual-baselines",
            status: "pass",
            message: `${visual.requiredViewports.length} visual baseline(s) are available.`,
          },
    );
  } else if (visual) {
    checks.push({
      id: "browser.visual-baselines",
      status: "warn",
      message: "Visual checks are enabled without baseline pixel comparison.",
      remediation:
        "Configure gates.browser.visual.baselineDirectory after approved screenshots are committed.",
    });
  }

  checks.push({
    id: "plan.slices",
    status: "pass",
    message: `${plan.slices.length} validated slice(s), ${plan.slices.flatMap((slice) => slice.acceptance).length} acceptance criterion/criteria.`,
  });

  return { projectRoot, checks, ok: !checks.some((check) => check.status === "fail") };
}
