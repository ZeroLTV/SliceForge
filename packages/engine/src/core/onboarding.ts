import * as fs from "fs";
import * as path from "path";
import { stringify as stringifyYaml } from "yaml";
import { detectProject, createDefaultConfig } from "./detector.js";
import type { SliceDefinition, SliceForgeConfig, SliceForgePlan } from "./contracts.js";
import { runProcess } from "./process-runner.js";
import { validateDocuments } from "./config-loader.js";

export interface InitOptions {
  agent?: "codex" | "claude" | "cursor";
  yes?: boolean;
  force?: boolean;
}

async function isAvailable(command: string, projectRoot: string): Promise<boolean> {
  const result = await runProcess(
    { command, args: ["--version"], timeoutMs: 5000 },
    { root: projectRoot, maxOutputBytes: 8192 },
  );
  return result.exitCode === 0;
}

async function chooseAgent(
  projectRoot: string,
  options: InitOptions,
): Promise<"codex" | "claude" | "cursor"> {
  if (options.agent) return options.agent;
  const availability = {
    codex: await isAvailable("codex", projectRoot),
    claude: await isAvailable("claude", projectRoot),
    cursor: await isAvailable("cursor-agent", projectRoot),
  };
  const detected = (Object.entries(availability).find(([, available]) => available)?.[0] ??
    "codex") as "codex" | "claude" | "cursor";
  if (options.yes || !process.stdin.isTTY || !process.stdout.isTTY) return detected;
  const { select } = await import("@inquirer/prompts");
  return select({
    message: "Select the workspace-capable agent for SliceForge",
    default: detected,
    choices: [
      { name: `Codex${availability.codex ? " (detected)" : ""}`, value: "codex" as const },
      { name: `Claude Code${availability.claude ? " (detected)" : ""}`, value: "claude" as const },
      { name: `Cursor CLI${availability.cursor ? " (detected)" : ""}`, value: "cursor" as const },
    ],
  });
}

function initialSlice(config: SliceForgeConfig): SliceDefinition {
  const targets = Object.keys(config.targets);
  const selectedTarget = targets[0];
  const affected = new Set<string>();
  const visit = (name: string): void => {
    if (affected.has(name)) return;
    for (const dependency of config.targets[name].dependsOn ?? []) visit(dependency);
    affected.add(name);
  };
  visit(selectedTarget);
  const available = (["build", "lint", "unit", "integration", "e2e"] as const).filter((kind) =>
    [...affected].every((name) => Boolean(config.targets[name].commands[kind])),
  );
  const fallbackArtifact = "docs/sliceforge/first-slice-evidence.md";
  return {
    id: "first-slice",
    title: "Describe the first independently verifiable change",
    description: "Replace this placeholder with a small, outcome-focused implementation slice.",
    priority: 1,
    targets: [selectedTarget],
    acceptance: [{ id: "AC-001", expected: "Describe an observable, testable result." }],
    allowedPaths: ["**/*"],
    requiredArtifacts: available.length > 0 ? undefined : [fallbackArtifact],
    requiredGates: available.length > 0 ? available : ["artifact"],
  };
}

function renderConfig(config: SliceForgeConfig): string {
  const serializable = {
    $schema: "https://unpkg.com/@zeroltv/sliceforge@1.0.0/dist/schemas/config.schema.json",
    ...config,
  };
  return [
    "// SliceForge configuration. Commands use command + args and run without a shell by default.",
    `${JSON.stringify(serializable, null, 2)}\n`,
  ].join("\n");
}

function writeProjectFiles(
  files: Array<{ filePath: string; content: string }>,
  force: boolean,
): void {
  for (const file of files) {
    if (fs.existsSync(file.filePath) && !force) {
      throw new Error(
        `Refusing to overwrite existing file: ${file.filePath}. Use --force to replace it.`,
      );
    }
  }
  const snapshots = files.map((file) => ({
    ...file,
    existed: fs.existsSync(file.filePath),
    previous: fs.existsSync(file.filePath) ? fs.readFileSync(file.filePath) : undefined,
    temporary: `${file.filePath}.${process.pid}.tmp`,
  }));
  try {
    for (const file of snapshots)
      fs.writeFileSync(file.temporary, file.content, { encoding: "utf8", mode: 0o600 });
    for (const file of snapshots) fs.renameSync(file.temporary, file.filePath);
  } catch (err) {
    for (const file of snapshots) {
      if (fs.existsSync(file.temporary)) fs.unlinkSync(file.temporary);
      if (file.existed && file.previous) fs.writeFileSync(file.filePath, file.previous);
      else if (!file.existed && fs.existsSync(file.filePath)) fs.unlinkSync(file.filePath);
    }
    throw err;
  }
}

export async function initializeProject(
  projectRoot: string,
  options: InitOptions = {},
): Promise<{ config: SliceForgeConfig; plan: SliceForgePlan; messages: string[] }> {
  const detection = detectProject(projectRoot);
  if (!options.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const { confirm } = await import("@inquirer/prompts");
    const accepted = await confirm({
      message: `Detected ${detection.signals.join(", ") || "a generic project"}. Continue?`,
      default: true,
    });
    if (!accepted) throw new Error("Initialization cancelled before writing files.");
  }
  const agent = await chooseAgent(projectRoot, options);
  const config = createDefaultConfig(detection, agent);
  const plan: SliceForgePlan = { schemaVersion: 1, slices: [initialSlice(config)] };
  validateDocuments(projectRoot, config, plan);
  writeProjectFiles(
    [
      {
        filePath: path.join(projectRoot, "sliceforge.config.jsonc"),
        content: renderConfig(config),
      },
      { filePath: path.join(projectRoot, "sliceforge.plan.yaml"), content: stringifyYaml(plan) },
    ],
    options.force ?? false,
  );
  return {
    config,
    plan,
    messages: [
      `Detected: ${detection.signals.join(", ") || "generic"}`,
      ...detection.warnings,
      "Next: run 'sliceforge doctor', then 'sliceforge do \"<request>\"'.",
    ],
  };
}
