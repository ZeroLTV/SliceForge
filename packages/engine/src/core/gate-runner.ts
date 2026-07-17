import * as fs from "fs";
import * as path from "path";
import type { GateKind, GateResult, SliceDefinition, SliceForgeConfig } from "./contracts.js";
import { runProcess } from "./process-runner.js";
import { validateArtifacts, validateDocumentation } from "./policy.js";
import { validateVisualManifest } from "./visual-validator.js";

const deterministicKinds: Array<"build" | "lint" | "unit" | "integration" | "e2e"> = [
  "build",
  "lint",
  "unit",
  "integration",
  "e2e",
];

function affectedTargets(config: SliceForgeConfig, slice: SliceDefinition): string[] {
  const targetNames: string[] = [];
  const visitedTargets = new Set<string>();
  const addTarget = (name: string): void => {
    if (visitedTargets.has(name)) return;
    for (const dependency of config.targets[name].dependsOn ?? []) addTarget(dependency);
    visitedTargets.add(name);
    targetNames.push(name);
  };
  for (const name of slice.targets) addTarget(name);
  return targetNames;
}

export async function prepareSliceTargets(
  config: SliceForgeConfig,
  slice: SliceDefinition,
  worktreeRoot: string,
  cancellationFile?: string,
  runtimeEnv: Record<string, string> = {},
): Promise<void> {
  const completed = new Set<string>();
  for (const targetName of affectedTargets(config, slice)) {
    const target = config.targets[targetName];
    if (!target.prepare) continue;
    const command = {
      ...target.prepare,
      cwd: target.prepare.cwd ? `${target.root}/${target.prepare.cwd}` : target.root,
    };
    const signature = JSON.stringify(command);
    if (completed.has(signature)) continue;
    completed.add(signature);
    const execution = await runProcess(command, {
      root: worktreeRoot,
      maxOutputBytes: config.reporting.maxLogBytes,
      cancellationFile,
      environment: runtimeEnv,
    });
    if (execution.exitCode !== 0) {
      throw new Error(
        `Preparation command failed for target '${targetName}' with exit ${execution.exitCode}: ${execution.stderr}`,
      );
    }
  }
}

function result(
  id: string,
  kind: GateKind,
  startedAt: number,
  status: GateResult["status"],
  summary: string,
  extra: Partial<GateResult> = {},
): GateResult {
  return {
    id,
    kind,
    status,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    summary,
    artifacts: [],
    ...extra,
  };
}

export class DeterministicGateRunner {
  async run(
    config: SliceForgeConfig,
    slice: SliceDefinition,
    worktreeRoot: string,
    cancellationFile?: string,
    runtimeEnv: Record<string, string> = {},
  ): Promise<GateResult[]> {
    const results: GateResult[] = [];
    const required = new Set(slice.requiredGates ?? []);
    const enabled = slice.requiredGates ? required : new Set(config.gates.order);
    const targetNames = affectedTargets(config, slice);

    if ((slice.requiredArtifacts ?? []).length > 0 || required.has("artifact")) {
      const startedAt = Date.now();
      const failures =
        required.has("artifact") && !(slice.requiredArtifacts ?? []).length
          ? ["artifact gate requires at least one requiredArtifact"]
          : validateArtifacts(worktreeRoot, slice.requiredArtifacts ?? []);
      if (slice.docsImpact === "required") {
        failures.push(...validateDocumentation(worktreeRoot, slice.docs ?? []));
      }
      results.push(
        result(
          `${slice.id}:artifact`,
          "artifact",
          startedAt,
          failures.length ? "failed" : "passed",
          failures.length
            ? [...new Set(failures)].join("; ")
            : "Required artifacts and documentation links exist and are safe.",
          { artifacts: slice.requiredArtifacts ?? [] },
        ),
      );
      if (failures.length) return results;
    }

    for (const kind of deterministicKinds) {
      if (!enabled.has(kind)) continue;
      for (const targetName of targetNames) {
        const target = config.targets[targetName];
        const command = target.commands[kind];
        const startedAt = Date.now();
        if (!command) {
          results.push(
            result(
              `${slice.id}:${targetName}:${kind}`,
              kind,
              startedAt,
              required.has(kind) ? "failed" : "skipped",
              required.has(kind)
                ? `Required gate '${kind}' has no command for target '${targetName}'.`
                : `No ${kind} command configured for ${targetName}.`,
            ),
          );
          if (required.has(kind)) return results;
          continue;
        }
        const executionCommand = {
          ...command,
          cwd: command.cwd ? `${target.root}/${command.cwd}` : target.root,
        };
        const execution = await runProcess(executionCommand, {
          root: worktreeRoot,
          maxOutputBytes: config.reporting.maxLogBytes,
          cancellationFile,
          environment: runtimeEnv,
        });
        results.push(
          result(
            `${slice.id}:${targetName}:${kind}`,
            kind,
            startedAt,
            execution.exitCode === 0 ? "passed" : "failed",
            execution.exitCode === 0
              ? `${targetName} ${kind} passed.`
              : `${targetName} ${kind} failed with exit ${execution.exitCode}.`,
            {
              command: executionCommand,
              stdout: execution.stdout,
              stderr: execution.stderr,
            },
          ),
        );
        if (execution.exitCode !== 0) return results;
      }
    }

    if (config.gates.browser.enabled && enabled.has("browser")) {
      const startedAt = Date.now();
      const command = config.gates.browser.command;
      if (!command) {
        results.push(
          result(
            `${slice.id}:browser`,
            "browser",
            startedAt,
            "failed",
            "Browser command is not configured.",
          ),
        );
        return results;
      }
      const executionCommand = { ...command };
      const execution = await runProcess(executionCommand, {
        root: worktreeRoot,
        maxOutputBytes: config.reporting.maxLogBytes,
        cancellationFile,
        environment: runtimeEnv,
      });
      let browserFailure = execution.exitCode !== 0 ? "Browser tests failed." : "";
      const browserArtifacts = config.gates.browser.reportPath
        ? [config.gates.browser.reportPath]
        : [];
      let visualSummary = "";
      if (!browserFailure && config.gates.browser.reportPath) {
        try {
          const reportFile = path.resolve(worktreeRoot, config.gates.browser.reportPath);
          const relative = path.relative(worktreeRoot, reportFile);
          if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error("report path escapes worktree");
          }
          const reportStat = fs.lstatSync(reportFile);
          if (!reportStat.isFile() || reportStat.isSymbolicLink()) {
            throw new Error("report must be a regular file, not a symlink");
          }
          const realRoot = fs.realpathSync.native(worktreeRoot);
          const realReport = fs.realpathSync.native(reportFile);
          const realRelative = path.relative(realRoot, realReport);
          if (
            realRelative === ".." ||
            realRelative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(realRelative)
          ) {
            throw new Error("report resolves through a symlink outside worktree");
          }
          const report = JSON.parse(fs.readFileSync(reportFile, "utf8")) as {
            stats?: { unexpected?: number; failures?: number };
          };
          if ((report.stats?.unexpected ?? report.stats?.failures ?? 0) > 0) {
            browserFailure = "Playwright JSON report contains failed tests.";
          }
        } catch (err) {
          browserFailure = `Playwright JSON report is missing or invalid: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
      if (!browserFailure && config.gates.browser.visual) {
        try {
          const visual = validateVisualManifest(worktreeRoot, config.gates.browser.visual);
          browserArtifacts.push(...visual.artifacts);
          visualSummary = ` ${visual.comparisons.length} visual viewport(s) validated.`;
          if (visual.failures.length) browserFailure = visual.failures.join("; ");
        } catch (error) {
          browserFailure = `Visual manifest is missing or invalid: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      results.push(
        result(
          `${slice.id}:browser`,
          "browser",
          startedAt,
          browserFailure ? "failed" : "passed",
          browserFailure ||
            `Deterministic browser tests passed with a valid JSON report.${visualSummary}`,
          {
            command: executionCommand,
            stdout: execution.stdout,
            stderr: execution.stderr,
            artifacts: [...new Set(browserArtifacts)],
          },
        ),
      );
    }
    return results;
  }
}

export function deterministicGatesPassed(results: GateResult[]): boolean {
  const deterministic = results.filter((gate) => gate.kind !== "review");
  return (
    deterministic.some((gate) => gate.status === "passed") &&
    !deterministic.some((gate) => gate.status === "failed")
  );
}
