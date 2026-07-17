import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { detectProject } from "../../src/core/detector";

const roots: string[] = [];
function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-detect-"));
  roots.push(value);
  return value;
}
function write(base: string, relative: string, content = ""): void {
  const file = path.join(base, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("project detector", () => {
  it("builds a pnpm workspace target dependency graph", () => {
    const project = root();
    write(project, "package.json", JSON.stringify({ name: "mono", packageManager: "pnpm@10.0.0" }));
    write(project, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    write(project, "pnpm-lock.yaml");
    write(
      project,
      "packages/core/package.json",
      JSON.stringify({ name: "@fixture/core", scripts: { build: "tsc" } }),
    );
    write(
      project,
      "packages/web/package.json",
      JSON.stringify({
        name: "@fixture/web",
        dependencies: { "@fixture/core": "workspace:*" },
        scripts: { test: "jest" },
      }),
    );
    const detection = detectProject(project);
    expect(detection.targets["fixture-core"].dependsOn).toEqual(["root"]);
    expect(detection.targets["fixture-web"].dependsOn).toEqual(["root", "fixture-core"]);
    expect(detection.targets["fixture-core"].prepare).toBeUndefined();
    expect(detection.targets.root.prepare).toMatchObject({
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
    });
    expect(detection.targets["fixture-core"].commands.build).toMatchObject({
      command: "pnpm",
      args: ["run", "build"],
    });
  });

  it.each([
    ["dotnet", "services/api/Api.csproj", "<Project />", "dotnet"],
    ["python-poetry", "pyproject.toml", "[tool.poetry]\npytest = '*'\nruff = '*'", "python"],
    ["java-maven", "pom.xml", "<project />", "java"],
    ["java-gradle", "build.gradle.kts", "plugins {}", "java"],
  ])("detects %s projects", (_name, file, content, preset) => {
    const project = root();
    write(project, file, content);
    if (_name === "python-poetry") write(project, "poetry.lock");
    const detection = detectProject(project);
    expect(Object.values(detection.targets).some((target) => target.preset === preset)).toBe(true);
    if (_name === "python-poetry") expect(detection.signals).toContain("Python (poetry)");
  });

  it("only configures declared Python tools and gives pip a prepare command", () => {
    const project = root();
    write(project, "requirements.txt", "pytest==8.4.0\nruff==0.12.0\nmypy==1.16.0\n");
    const target = detectProject(project).targets.python;
    expect(target.prepare).toMatchObject({
      command: "python",
      args: ["-m", "pip", "install", "-r", "requirements.txt"],
    });
    expect(target.commands).toMatchObject({
      build: { args: ["-m", "mypy", "."] },
      lint: { args: ["-m", "ruff", "check", "."] },
      unit: { args: ["-m", "pytest"] },
    });

    const minimal = root();
    write(minimal, "requirements.txt", "requests==2.32.0\n");
    const detection = detectProject(minimal);
    expect(detection.targets.python.commands).toEqual({});
    expect(detection.warnings).toContain(
      "Python was detected without pytest, Ruff or mypy declarations; configure deterministic commands explicitly.",
    );
  });

  it("allows the non-secret OS and SDK environment required by generated commands", () => {
    const project = root();
    write(project, "Smoke.csproj", "<Project />");
    const allowlist = detectProject(project).targets.dotnet.prepare?.envAllowlist;
    expect(allowlist).toEqual(
      expect.arrayContaining([
        "PATH",
        "LOCALAPPDATA",
        "APPDATA",
        "DOTNET_CLI_HOME",
        "NUGET_PACKAGES",
        "JAVA_HOME",
        "GRADLE_USER_HOME",
        "VIRTUAL_ENV",
      ]),
    );
    expect(allowlist).not.toEqual(expect.arrayContaining(["OPENAI_API_KEY", "NPM_TOKEN"]));
  });

  it("detects React Native separately from a generic Node target", () => {
    const project = root();
    write(
      project,
      "package.json",
      JSON.stringify({
        dependencies: { "react-native": "0.80.0" },
        scripts: { test: "jest", "test:e2e": "detox test" },
      }),
    );
    const detection = detectProject(project);
    expect(detection.targets.root.preset).toBe("react-native");
    expect(detection.targets.root.commands.e2e?.args).toEqual(["run", "test:e2e"]);
  });

  it.each([
    ["npm lock", { packageManager: "npm@10.8.0" }, "package-lock.json", ["ci"]],
    ["npm no lock", { packageManager: "npm@10.8.0" }, undefined, ["install"]],
    [
      "Yarn Classic",
      { packageManager: "yarn@1.22.22" },
      "yarn.lock",
      ["install", "--frozen-lockfile"],
    ],
    ["Yarn Berry", { packageManager: "yarn@4.9.2" }, "yarn.lock", ["install", "--immutable"]],
    [
      "pnpm lock",
      { packageManager: "pnpm@10.0.0" },
      "pnpm-lock.yaml",
      ["install", "--frozen-lockfile"],
    ],
    ["pnpm no lock", { packageManager: "pnpm@10.0.0" }, undefined, ["install"]],
  ])("creates a usable %s prepare command", (_name, manifest, lockfile, args) => {
    const project = root();
    write(project, "package.json", JSON.stringify({ name: "fixture", ...manifest }));
    if (lockfile) write(project, lockfile);
    const detection = detectProject(project);
    expect(detection.targets.root.prepare?.args).toEqual(args);
    expect(
      detection.warnings.some((warning) => /cannot be frozen|cannot use npm ci/.test(warning)),
    ).toBe(!lockfile);
  });

  it("uses a system Gradle command only when no wrapper is present", () => {
    const withoutWrapper = root();
    write(withoutWrapper, "build.gradle.kts", "plugins {}");
    expect(detectProject(withoutWrapper).targets.java.prepare?.command).toBe("gradle");

    const withWrapper = root();
    write(withWrapper, "build.gradle.kts", "plugins {}");
    write(withWrapper, process.platform === "win32" ? "gradlew.bat" : "gradlew");
    expect(detectProject(withWrapper).targets.java.prepare?.command).toBe("./gradlew");
  });

  it("uses a portable Maven wrapper command when either platform wrapper exists", () => {
    for (const wrapper of ["mvnw", "mvnw.cmd"]) {
      const project = root();
      write(project, "pom.xml", "<project />");
      write(project, wrapper);
      expect(detectProject(project).targets.java.prepare?.command).toBe("./mvnw");
    }
  });
});
