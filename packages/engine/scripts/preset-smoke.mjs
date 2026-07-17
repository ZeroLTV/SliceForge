import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDefaultConfig, detectProject, runProcess, validateConfig } from "../dist/index.js";

const roots = [];
const detectOnly = process.argv.includes("--detect-only");
const selected = (() => {
  const index = process.argv.indexOf("--fixture");
  return index < 0 ? undefined : process.argv[index + 1];
})();

function fixtureRoot(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `sliceforge-preset-${name}-`));
  roots.push(root);
  return root;
}

function write(root, relative, content = "") {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function packageJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function nodeFixture() {
  const root = fixtureRoot("node");
  write(
    root,
    "package.json",
    packageJson({
      name: "node-smoke",
      version: "1.0.0",
      scripts: {
        build: "node -e \"process.stdout.write('build')\"",
        lint: "node -e \"process.stdout.write('lint')\"",
        "test:unit": "node -e \"process.stdout.write('unit')\"",
        "test:integration": "node -e \"process.stdout.write('integration')\"",
      },
    }),
  );
  write(
    root,
    "package-lock.json",
    JSON.stringify({
      name: "node-smoke",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: { "": { name: "node-smoke", version: "1.0.0" } },
    }),
  );
  return { name: "node", root, presets: ["node"], signals: ["node (npm)"] };
}

function reactNativeFixture() {
  const root = fixtureRoot("react-native");
  write(
    root,
    "package.json",
    packageJson({
      name: "react-native-smoke",
      version: "1.0.0",
      dependencies: { "react-native": "file:./react-native-stub" },
      scripts: {
        build: "node -e \"process.stdout.write('metro-build')\"",
        test: "node -e \"process.stdout.write('jest')\"",
        "test:e2e": "node -e \"process.stdout.write('mobile-e2e')\"",
      },
    }),
  );
  write(
    root,
    "react-native-stub/package.json",
    packageJson({ name: "react-native", version: "0.0.0" }),
  );
  return {
    name: "react-native",
    root,
    presets: ["react-native"],
    signals: ["react-native (npm)"],
  };
}

function pythonFixture() {
  const root = fixtureRoot("python");
  write(root, "requirements.txt", "mypy>=1.10\npytest>=8.0\nruff>=0.5\n");
  write(root, "app.py", "def add(left: int, right: int) -> int:\n    return left + right\n");
  write(
    root,
    "test_app.py",
    "from app import add\n\n\ndef test_add() -> None:\n    assert add(1, 2) == 3\n",
  );
  return { name: "python", root, presets: ["python"], signals: ["Python (pip)"] };
}

function dotnetFixture() {
  const root = fixtureRoot("dotnet");
  write(
    root,
    "Smoke.csproj",
    `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
  </PropertyGroup>
</Project>
`,
  );
  write(root, "Program.cs", 'Console.WriteLine("SliceForge preset smoke");\n');
  return { name: "dotnet", root, presets: ["dotnet"], signals: [".NET (Smoke.csproj)"] };
}

function mavenFixture() {
  const root = fixtureRoot("maven");
  write(
    root,
    "pom.xml",
    `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>invalid.sliceforge</groupId><artifactId>smoke-parent</artifactId><version>1.0.0</version>
  <packaging>pom</packaging><modules><module>app</module></modules>
  <properties><maven.compiler.release>17</maven.compiler.release></properties>
</project>
`,
  );
  write(
    root,
    "app/pom.xml",
    `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <parent><groupId>invalid.sliceforge</groupId><artifactId>smoke-parent</artifactId><version>1.0.0</version></parent>
  <artifactId>smoke-app</artifactId>
</project>
`,
  );
  write(
    root,
    "app/src/main/java/invalid/sliceforge/App.java",
    'package invalid.sliceforge; public final class App { public static String value() { return "ok"; } }\n',
  );
  return { name: "java-maven", root, presets: ["java"], signals: ["Java (Maven)"] };
}

function gradleFixture() {
  const root = fixtureRoot("gradle");
  write(root, "settings.gradle", "rootProject.name = 'smoke-parent'\ninclude 'app'\n");
  write(
    root,
    "build.gradle",
    "allprojects { repositories { mavenCentral() } }\nsubprojects { apply plugin: 'java' }\n",
  );
  write(
    root,
    "app/src/main/java/invalid/sliceforge/App.java",
    'package invalid.sliceforge; public final class App { public static String value() { return "ok"; } }\n',
  );
  return { name: "java-gradle", root, presets: ["java"], signals: ["Java (Gradle)"] };
}

function monorepoFixture() {
  const root = fixtureRoot("monorepo");
  write(
    root,
    "package.json",
    packageJson({ name: "monorepo-smoke", version: "1.0.0", workspaces: ["packages/*"] }),
  );
  write(root, "nx.json", "{}\n");
  write(root, "turbo.json", '{"tasks":{}}\n');
  write(
    root,
    "packages/core/package.json",
    packageJson({
      name: "@smoke/core",
      version: "1.0.0",
      scripts: { build: "node -e \"process.stdout.write('core')\"" },
    }),
  );
  write(
    root,
    "packages/web/package.json",
    packageJson({
      name: "@smoke/web",
      version: "1.0.0",
      dependencies: { "@smoke/core": "1.0.0" },
      scripts: { test: "node -e \"process.stdout.write('web')\"" },
    }),
  );
  return {
    name: "node-monorepo",
    root,
    presets: ["node"],
    signals: ["node (npm)", "Nx monorepo", "Turborepo"],
    assert(detection) {
      if (JSON.stringify(detection.targets["smoke-web"].dependsOn) !== '["root","smoke-core"]') {
        throw new Error(
          "Monorepo dependency graph did not preserve root and package dependencies.",
        );
      }
    },
  };
}

function pnpmWorkspaceFixture() {
  const root = fixtureRoot("pnpm-workspace");
  write(
    root,
    "package.json",
    packageJson({
      name: "pnpm-workspace-smoke",
      version: "1.0.0",
      private: true,
      packageManager: "pnpm@10.0.0",
    }),
  );
  write(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write(
    root,
    "packages/core/package.json",
    packageJson({
      name: "@pnpm-smoke/core",
      version: "1.0.0",
      scripts: { build: "node -e \"process.stdout.write('pnpm-core')\"" },
    }),
  );
  write(
    root,
    "packages/web/package.json",
    packageJson({
      name: "@pnpm-smoke/web",
      version: "1.0.0",
      dependencies: { "@pnpm-smoke/core": "workspace:*" },
      scripts: { test: "node -e \"process.stdout.write('pnpm-web')\"" },
    }),
  );
  return {
    name: "node-pnpm-workspace",
    root,
    presets: ["node"],
    signals: ["node (pnpm)"],
    assert(detection) {
      if (
        JSON.stringify(detection.targets["pnpm-smoke-web"].dependsOn) !==
        '["root","pnpm-smoke-core"]'
      ) {
        throw new Error("pnpm workspace dependencies were not topologically ordered.");
      }
    },
  };
}

function yarnWorkspaceFixture() {
  const root = fixtureRoot("yarn-workspace");
  write(
    root,
    "package.json",
    packageJson({
      name: "yarn-workspace-smoke",
      version: "1.0.0",
      private: true,
      packageManager: "yarn@1.22.22",
      workspaces: ["packages/*"],
    }),
  );
  write(
    root,
    "packages/core/package.json",
    packageJson({
      name: "@yarn-smoke/core",
      version: "1.0.0",
      scripts: { build: "node -e \"process.stdout.write('yarn-core')\"" },
    }),
  );
  write(
    root,
    "packages/web/package.json",
    packageJson({
      name: "@yarn-smoke/web",
      version: "1.0.0",
      dependencies: { "@yarn-smoke/core": "1.0.0" },
      scripts: { test: "node -e \"process.stdout.write('yarn-web')\"" },
    }),
  );
  return {
    name: "node-yarn-workspace",
    root,
    presets: ["node"],
    signals: ["node (yarn)"],
    assert(detection) {
      if (
        JSON.stringify(detection.targets["yarn-smoke-web"].dependsOn) !==
        '["root","yarn-smoke-core"]'
      ) {
        throw new Error("Yarn workspace dependencies were not topologically ordered.");
      }
    },
  };
}

async function executeCommand(fixture, targetName, kind, spec) {
  const target = fixture.detection.targets[targetName];
  const cwd = path.resolve(fixture.root, target.root, spec.cwd ?? ".");
  const result = await runProcess(spec, { root: cwd, maxOutputBytes: 1_048_576 });
  if (result.exitCode !== 0) {
    throw new Error(
      `${fixture.name}:${targetName}:${kind} failed (${result.exitCode})\n${result.stdout}\n${result.stderr}`,
    );
  }
}

async function executeTarget(fixture, targetName, completed) {
  if (completed.has(targetName)) return;
  const target = fixture.detection.targets[targetName];
  for (const dependency of target.dependsOn ?? []) {
    await executeTarget(fixture, dependency, completed);
  }
  if (target.prepare) await executeCommand(fixture, targetName, "prepare", target.prepare);
  for (const kind of ["build", "lint", "unit", "integration", "e2e"]) {
    if (target.commands[kind]) {
      await executeCommand(fixture, targetName, kind, target.commands[kind]);
    }
  }
  completed.add(targetName);
}

async function main() {
  const fixtures = [
    nodeFixture(),
    reactNativeFixture(),
    pythonFixture(),
    dotnetFixture(),
    mavenFixture(),
    gradleFixture(),
    monorepoFixture(),
    pnpmWorkspaceFixture(),
    yarnWorkspaceFixture(),
  ].filter((fixture) => !selected || fixture.name === selected);
  if (!fixtures.length) throw new Error(`Unknown fixture: ${selected}`);

  try {
    for (const fixture of fixtures) {
      const detection = detectProject(fixture.root);
      fixture.detection = detection;
      validateConfig(createDefaultConfig(detection, "codex"), fixture.root);
      for (const preset of fixture.presets) {
        if (!Object.values(detection.targets).some((target) => target.preset === preset)) {
          throw new Error(`${fixture.name} did not detect preset ${preset}.`);
        }
      }
      for (const signal of fixture.signals) {
        if (!detection.signals.includes(signal)) {
          throw new Error(`${fixture.name} did not emit signal '${signal}'.`);
        }
      }
      fixture.assert?.(detection);
      if (!detectOnly) {
        const completed = new Set();
        for (const targetName of Object.keys(detection.targets)) {
          await executeTarget(fixture, targetName, completed);
        }
      }
      process.stdout.write(
        `${JSON.stringify({
          fixture: fixture.name,
          passed: true,
          mode: detectOnly ? "detect-only" : "execute",
          targets: Object.keys(detection.targets),
          signals: detection.signals,
        })}\n`,
      );
    }
  } finally {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
