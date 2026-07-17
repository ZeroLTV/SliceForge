import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import type { CommandSpec, SliceForgeConfig, TargetDefinition, TargetPreset } from "./contracts.js";

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
  packageManager?: string;
}

const STANDARD_TOOL_ENV = [
  "PATH",
  "Path",
  "PATHEXT",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "HOME",
  "USERPROFILE",
  "USERNAME",
  "TMP",
  "TEMP",
  "TMPDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "LANG",
  "LC_ALL",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "DOTNET_CLI_HOME",
  "DOTNET_ROOT",
  "NUGET_PACKAGES",
  "JAVA_HOME",
  "JAVA_TOOL_OPTIONS",
  "MAVEN_HOME",
  "M2_HOME",
  "MAVEN_OPTS",
  "GRADLE_HOME",
  "GRADLE_USER_HOME",
  "PYTHONHOME",
  "VIRTUAL_ENV",
  "PIP_CACHE_DIR",
  "POETRY_CACHE_DIR",
  "UV_CACHE_DIR",
  "npm_config_cache",
  "COREPACK_HOME",
  "PNPM_HOME",
  "YARN_CACHE_FOLDER",
];

export interface DetectionResult {
  project: string;
  targets: Record<string, TargetDefinition>;
  signals: string[];
  warnings: string[];
}

function command(commandName: string, args: string[], cwd = "."): CommandSpec {
  return {
    command: commandName,
    args,
    cwd,
    timeoutMs: 10 * 60 * 1000,
    envAllowlist: STANDARD_TOOL_ENV,
  };
}

function packageManager(root: string): "pnpm" | "yarn" | "npm" {
  const packagePath = path.join(root, "package.json");
  if (fs.existsSync(packagePath)) {
    const declared = (
      JSON.parse(fs.readFileSync(packagePath, "utf8")) as PackageManifest
    ).packageManager?.split("@")[0];
    if (declared === "pnpm" || declared === "yarn" || declared === "npm") return declared;
  }
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

function scriptCommand(manager: "pnpm" | "yarn" | "npm", script: string): CommandSpec {
  return command(manager, ["run", script]);
}

function declaredPackageManagerVersion(root: string): string | undefined {
  const packagePath = path.join(root, "package.json");
  if (!fs.existsSync(packagePath)) return undefined;
  const declared = (JSON.parse(fs.readFileSync(packagePath, "utf8")) as PackageManifest)
    .packageManager;
  return declared?.slice(declared.indexOf("@") + 1);
}

function installCommand(
  manager: "pnpm" | "yarn" | "npm",
  root: string,
  warnings: string[],
): CommandSpec {
  if (manager === "pnpm") {
    if (fs.existsSync(path.join(root, "pnpm-lock.yaml")))
      return command("pnpm", ["install", "--frozen-lockfile"]);
    warnings.push("pnpm was detected without pnpm-lock.yaml; prepare cannot be frozen.");
    return command("pnpm", ["install"]);
  }
  if (manager === "yarn") {
    if (!fs.existsSync(path.join(root, "yarn.lock"))) {
      warnings.push("Yarn was detected without yarn.lock; prepare cannot be frozen.");
      return command("yarn", ["install"]);
    }
    const major = Number.parseInt(declaredPackageManagerVersion(root)?.split(".")[0] ?? "1", 10);
    const modern = fs.existsSync(path.join(root, ".yarnrc.yml")) || major >= 2;
    return command("yarn", ["install", modern ? "--immutable" : "--frozen-lockfile"]);
  }
  if (
    fs.existsSync(path.join(root, "package-lock.json")) ||
    fs.existsSync(path.join(root, "npm-shrinkwrap.json"))
  ) {
    return command("npm", ["ci"]);
  }
  warnings.push("npm was detected without package-lock.json; prepare cannot use npm ci.");
  return command("npm", ["install"]);
}

function commandsFromScripts(
  manager: "pnpm" | "yarn" | "npm",
  scripts: Record<string, string> = {},
): TargetDefinition["commands"] {
  const commands: TargetDefinition["commands"] = {};
  if (scripts.build) commands.build = scriptCommand(manager, "build");
  if (scripts.lint) commands.lint = scriptCommand(manager, "lint");
  if (scripts["test:unit"]) commands.unit = scriptCommand(manager, "test:unit");
  else if (scripts.test) commands.unit = scriptCommand(manager, "test");
  if (scripts["test:integration"])
    commands.integration = scriptCommand(manager, "test:integration");
  if (scripts["test:e2e"]) commands.e2e = scriptCommand(manager, "test:e2e");
  if (scripts["test:browser"]) commands.browser = scriptCommand(manager, "test:browser");
  return commands;
}

function safeName(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-|-$/g, "") || "app"
  );
}

function expandWorkspacePattern(projectRoot: string, pattern: string): string[] {
  const normalized = pattern.replace(/\\/g, "/").replace(/\/$/, "");
  if (!normalized.includes("*"))
    return fs.existsSync(path.join(projectRoot, normalized)) ? [normalized] : [];
  const segments = normalized.split("/");
  if (segments.filter((segment) => segment === "*").length !== 1 || segments.at(-1) !== "*")
    return [];
  const parent = segments.slice(0, -1).join("/");
  const directory = path.join(projectRoot, parent);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.posix.join(parent, entry.name));
}

function addTarget(
  targets: Record<string, TargetDefinition>,
  preferredName: string,
  target: TargetDefinition,
): string {
  let name = safeName(preferredName);
  let suffix = 2;
  while (targets[name]) name = `${safeName(preferredName)}-${suffix++}`;
  targets[name] = target;
  return name;
}

function pnpmWorkspacePatterns(projectRoot: string): string[] {
  const workspacePath = path.join(projectRoot, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspacePath)) return [];
  try {
    const value = parseYaml(fs.readFileSync(workspacePath, "utf8")) as { packages?: unknown };
    return Array.isArray(value?.packages)
      ? value.packages.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function findFiles(root: string, extension: string, maxDepth = 4): string[] {
  const found: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === "bin" ||
        entry.name === "obj"
      )
        continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(extension))
        found.push(path.relative(root, absolute));
    }
  };
  visit(root, 0);
  return found;
}

export function detectProject(projectRoot: string): DetectionResult {
  const targets: Record<string, TargetDefinition> = {};
  const signals: string[] = [];
  const warnings: string[] = [];
  let project = path.basename(projectRoot);

  const packagePath = path.join(projectRoot, "package.json");
  if (fs.existsSync(packagePath)) {
    const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8")) as PackageManifest;
    project = manifest.name ?? project;
    const manager = packageManager(projectRoot);
    const dependencies = { ...(manifest.dependencies ?? {}), ...(manifest.devDependencies ?? {}) };
    const preset: TargetPreset = dependencies["react-native"] ? "react-native" : "node";
    const rootPrepare = installCommand(manager, projectRoot, warnings);
    const rootTarget = addTarget(targets, "root", {
      root: ".",
      preset,
      prepare: rootPrepare,
      commands: commandsFromScripts(manager, manifest.scripts),
    });
    signals.push(`${preset} (${manager})`);

    const workspacePatterns = [
      ...new Set(
        (Array.isArray(manifest.workspaces)
          ? manifest.workspaces
          : (manifest.workspaces?.packages ?? [])
        ).concat(pnpmWorkspacePatterns(projectRoot)),
      ),
    ];
    const packageTargets = new Map<string, string>();
    if (manifest.name) packageTargets.set(manifest.name, rootTarget);
    const workspaceManifests: Array<{ targetName: string; manifest: PackageManifest }> = [];
    const detectedWorkspaceRoots = new Set<string>();
    for (const pattern of workspacePatterns) {
      for (const workspaceRoot of expandWorkspacePattern(projectRoot, pattern)) {
        if (detectedWorkspaceRoots.has(workspaceRoot)) continue;
        detectedWorkspaceRoots.add(workspaceRoot);
        const workspacePackage = path.join(projectRoot, workspaceRoot, "package.json");
        if (!fs.existsSync(workspacePackage)) continue;
        const workspaceManifest = JSON.parse(
          fs.readFileSync(workspacePackage, "utf8"),
        ) as PackageManifest;
        const workspaceDeps = {
          ...(workspaceManifest.dependencies ?? {}),
          ...(workspaceManifest.devDependencies ?? {}),
        };
        const targetName = addTarget(
          targets,
          workspaceManifest.name ?? path.basename(workspaceRoot),
          {
            root: workspaceRoot,
            preset: workspaceDeps["react-native"] ? "react-native" : "node",
            dependsOn: [rootTarget],
            commands: commandsFromScripts(manager, workspaceManifest.scripts),
          },
        );
        if (workspaceManifest.name) packageTargets.set(workspaceManifest.name, targetName);
        workspaceManifests.push({ targetName, manifest: workspaceManifest });
      }
    }
    for (const workspace of workspaceManifests) {
      const dependencies = {
        ...(workspace.manifest.dependencies ?? {}),
        ...(workspace.manifest.devDependencies ?? {}),
      };
      const dependsOn = Object.keys(dependencies)
        .map((name) => packageTargets.get(name))
        .filter((name): name is string => Boolean(name && name !== workspace.targetName));
      targets[workspace.targetName].dependsOn = [
        ...new Set([...(targets[workspace.targetName].dependsOn ?? []), ...dependsOn]),
      ];
    }
    if (fs.existsSync(path.join(projectRoot, "nx.json"))) signals.push("Nx monorepo");
    if (fs.existsSync(path.join(projectRoot, "turbo.json"))) signals.push("Turborepo");
  }

  const topLevel = fs.readdirSync(projectRoot, { withFileTypes: true });
  const solution = topLevel.find((entry) => entry.isFile() && entry.name.endsWith(".sln"));
  const csproj = topLevel.find((entry) => entry.isFile() && entry.name.endsWith(".csproj"));
  if (solution || csproj) {
    const file = solution?.name ?? csproj!.name;
    addTarget(targets, "dotnet", {
      root: ".",
      preset: "dotnet",
      prepare: command("dotnet", ["restore", file]),
      commands: {
        build: command("dotnet", ["build", file, "--no-restore"]),
        lint: command("dotnet", ["format", file, "--verify-no-changes"]),
        unit: command("dotnet", ["test", file, "--no-build"]),
      },
    });
    signals.push(`.NET (${file})`);
  } else {
    for (const projectFile of findFiles(projectRoot, ".csproj")) {
      const projectDirectory = path.dirname(projectFile);
      const fileName = path.basename(projectFile);
      addTarget(targets, path.basename(fileName, ".csproj"), {
        root: projectDirectory,
        preset: "dotnet",
        prepare: command("dotnet", ["restore", fileName]),
        commands: {
          build: command("dotnet", ["build", fileName, "--no-restore"]),
          lint: command("dotnet", ["format", fileName, "--verify-no-changes"]),
          unit: command("dotnet", ["test", fileName, "--no-build"]),
        },
      });
      signals.push(`.NET (${projectFile})`);
    }
  }

  if (
    fs.existsSync(path.join(projectRoot, "pyproject.toml")) ||
    fs.existsSync(path.join(projectRoot, "requirements.txt"))
  ) {
    const requirementsPath = path.join(projectRoot, "requirements.txt");
    const pyprojectPath = path.join(projectRoot, "pyproject.toml");
    const pythonManifest = [requirementsPath, pyprojectPath]
      .filter((file) => fs.existsSync(file))
      .map((file) => fs.readFileSync(file, "utf8").toLowerCase())
      .join("\n");
    const declares = (tool: string): boolean =>
      new RegExp(
        `(^|[^a-z0-9_-])${tool.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_-]|$)`,
      ).test(pythonManifest);
    const runner = fs.existsSync(path.join(projectRoot, "uv.lock"))
      ? "uv"
      : fs.existsSync(path.join(projectRoot, "poetry.lock"))
        ? "poetry"
        : "python";
    const prefix = runner === "uv" ? ["run"] : runner === "poetry" ? ["run"] : ["-m"];
    const commands: TargetDefinition["commands"] = {};
    if (declares("mypy")) commands.build = command(runner, [...prefix, "mypy", "."]);
    if (declares("ruff")) commands.lint = command(runner, [...prefix, "ruff", "check", "."]);
    if (declares("pytest")) commands.unit = command(runner, [...prefix, "pytest"]);
    if (!Object.keys(commands).length) {
      warnings.push(
        "Python was detected without pytest, Ruff or mypy declarations; configure deterministic commands explicitly.",
      );
    }
    addTarget(targets, "python", {
      root: ".",
      preset: "python",
      prepare:
        runner === "uv"
          ? command("uv", ["sync", "--frozen"])
          : runner === "poetry"
            ? command("poetry", ["install", "--no-interaction"])
            : fs.existsSync(requirementsPath)
              ? command("python", ["-m", "pip", "install", "-r", "requirements.txt"])
              : command("python", ["-m", "pip", "install", "."]),
      commands,
    });
    signals.push(`Python (${runner === "python" ? "pip" : runner})`);
  }

  if (fs.existsSync(path.join(projectRoot, "pom.xml"))) {
    const maven =
      fs.existsSync(path.join(projectRoot, "mvnw")) ||
      fs.existsSync(path.join(projectRoot, "mvnw.cmd"))
        ? "./mvnw"
        : "mvn";
    addTarget(targets, "java", {
      root: ".",
      preset: "java",
      prepare: command(maven, ["-B", "dependency:go-offline"]),
      commands: {
        build: command(maven, ["-B", "verify"]),
        unit: command(maven, ["-B", "test"]),
      },
    });
    signals.push("Java (Maven)");
  } else if (
    fs.existsSync(path.join(projectRoot, "build.gradle")) ||
    fs.existsSync(path.join(projectRoot, "build.gradle.kts"))
  ) {
    const hasWrapper =
      fs.existsSync(path.join(projectRoot, "gradlew")) ||
      fs.existsSync(path.join(projectRoot, "gradlew.bat"));
    const wrapper = hasWrapper ? "./gradlew" : "gradle";
    addTarget(targets, "java", {
      root: ".",
      preset: "java",
      prepare: command(wrapper, ["dependencies"]),
      commands: { build: command(wrapper, ["build"]), unit: command(wrapper, ["test"]) },
    });
    signals.push("Java (Gradle)");
  }

  if (Object.keys(targets).length === 0) {
    targets.app = { root: ".", preset: "generic", commands: {} };
    warnings.push(
      "No known stack was detected; configure generic target commands in sliceforge.config.jsonc.",
    );
  }

  return { project, targets, signals, warnings };
}

export function createDefaultConfig(
  detection: DetectionResult,
  agentType: "codex" | "claude" | "cursor",
): SliceForgeConfig {
  const agent = { type: agentType } as const;
  return {
    schemaVersion: 1,
    project: detection.project,
    agents: {
      clarifier: agent,
      planner: agent,
      implementer: agent,
      testgen: agent,
      reviewer: agent,
    },
    targets: detection.targets,
    isolation: { mode: "worktree" },
    gates: {
      order: ["artifact", "build", "lint", "unit", "integration", "e2e", "browser", "review"],
      browser: { enabled: false },
      review: { enabled: true, advisory: true },
    },
    policies: {
      protectedPatterns: [
        "**/.env*",
        "**/*.pem",
        "**/*.key",
        "**/*.pfx",
        "**/*.secret",
        ".git/**",
        ".sliceforge/**",
        "sliceforge.config.jsonc",
        "sliceforge.plan.yaml",
      ],
      maxRetries: 2,
    },
    routing: { fallbackRole: "implementer", minimumReadinessScore: 70, rules: [] },
    execution: {
      concurrency: 1,
      taskTimeoutMs: 60 * 60 * 1000,
      maxRepairAttempts: 3,
      maxRepeatedFailure: 2,
      leaseMs: 60_000,
      portRange: { start: 41_000, end: 41_999 },
      portEnv: ["PORT", "SLICEFORGE_PORT"],
    },
    evaluation: {
      repetitions: 10,
      contextVariants: ["original", "reordered", "irrelevant", "reduced"],
      maxSuccessRateRegression: 0.05,
      requireSchemaCompliance: true,
    },
    inputs: { maxAttachmentBytes: 10 * 1024 * 1024 },
    documentation: { defaultImpact: "review", requireReviewWhenUncertain: true },
    reporting: { retainRuns: 50, maxLogBytes: 1048576 },
    ci: { reportOnly: true },
  };
}
