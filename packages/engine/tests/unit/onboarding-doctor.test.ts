import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import { initializeProject } from "../../src/core/onboarding";
import { validateProject } from "../../src/core/config-loader";
import { runDoctor } from "../../src/core/doctor";
import type { SliceForgeConfig, SliceForgePlan } from "../../src/core/contracts";

const roots: string[] = [];
jest.setTimeout(60_000);

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-onboarding-"));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("onboarding", () => {
  it("creates an executable artifact fallback for an unknown project", async () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, "README.md"), "unknown fixture\n");
    const initialized = await initializeProject(root, { agent: "codex", yes: true });

    expect(initialized.plan.slices[0]).toMatchObject({
      requiredGates: ["artifact"],
      requiredArtifacts: ["docs/sliceforge/first-slice-evidence.md"],
    });
    expect(fs.readFileSync(path.join(root, "sliceforge.config.jsonc"), "utf8")).toContain(
      "https://unpkg.com/@zeroltv/sliceforge@1.0.0/dist/schemas/config.schema.json",
    );
    expect(validateProject(root).plan.slices).toHaveLength(1);
  });

  it("stores a Cursor model once and leaves role arguments to the adapter", async () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, "README.md"), "Cursor fixture\n");
    const initialized = await initializeProject(root, {
      agent: "cursor",
      model: "gpt-5-codex",
      yes: true,
    });

    expect(initialized.config.agents).toMatchObject({
      clarifier: { type: "cursor", model: "gpt-5-codex" },
      planner: { type: "cursor", model: "gpt-5-codex" },
      implementer: { type: "cursor", model: "gpt-5-codex" },
      testgen: { type: "cursor", model: "gpt-5-codex" },
      reviewer: { type: "cursor", model: "gpt-5-codex" },
    });
    for (const agent of Object.values(initialized.config.agents)) {
      expect(agent).not.toHaveProperty("args");
    }
    expect(validateProject(root).plan.slices).toHaveLength(1);
  });
});

describe("doctor", () => {
  it("explains missing gate, prepare and browser executables", async () => {
    const root = temporaryRoot();
    git(root, "init", "-b", "main");
    git(root, "config", "user.name", "SliceForge Test");
    git(root, "config", "user.email", "sliceforge@example.invalid");
    fs.writeFileSync(path.join(root, "README.md"), "doctor fixture\n");
    git(root, "add", ".");
    git(root, "commit", "-m", "fixture");

    const agent = {
      type: "command" as const,
      command: process.execPath,
      args: ["--version"],
      capabilities: ["implementer" as const, "testgen" as const, "reviewer" as const],
    };
    const config: SliceForgeConfig = {
      schemaVersion: 1,
      project: "doctor-fixture",
      agents: { implementer: agent, testgen: agent, reviewer: agent },
      targets: {
        app: {
          root: ".",
          preset: "python",
          prepare: { command: "sliceforge-missing-prepare-executable" },
          commands: {},
        },
      },
      isolation: { mode: "worktree" },
      gates: {
        order: ["unit", "browser"],
        browser: {
          enabled: true,
          command: { command: "sliceforge-missing-browser-executable" },
          reportPath: "artifacts/playwright.json",
          visual: {
            artifactDirectory: "artifacts/visual",
            manifestPath: "artifacts/visual/manifest.json",
            baselineDirectory: "tests/visual-baselines",
            requiredViewports: [{ id: "desktop", width: 1280, height: 720 }],
            maxDiffRatio: 0,
            pixelThreshold: 0.1,
            maxScreenshotBytes: 5 * 1024 * 1024,
            requireNoRuntimeErrors: true,
            requireNoOverflow: true,
            requireAccessibility: true,
            requireAssets: true,
          },
        },
        review: { enabled: false, advisory: true },
      },
      policies: { protectedPatterns: [], maxRetries: 0 },
      routing: {
        fallbackRole: "implementer",
        rules: [
          {
            role: "planner",
            targets: ["app"],
            agent: {
              type: "command",
              command: "sliceforge-missing-routed-agent",
              capabilities: ["planner"],
            },
          },
        ],
      },
      reporting: { retainRuns: 10, maxLogBytes: 65536 },
      ci: { reportOnly: true },
    };
    const plan: SliceForgePlan = {
      schemaVersion: 1,
      slices: [
        {
          id: "doctor-slice",
          title: "Doctor slice",
          priority: 1,
          targets: ["app"],
          acceptance: [{ id: "DOC-1", expected: "dependencies are explained" }],
          allowedPaths: ["src/**"],
          requiredGates: ["unit", "browser"],
        },
      ],
    };

    const report = await runDoctor(root, config, plan);
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "execution.port-allocator", status: "pass" }),
      ]),
    );
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "executable.sliceforge-missing-prepare-executable",
          status: "fail",
        }),
        expect.objectContaining({ id: "plan.doctor-slice.app.unit", status: "fail" }),
        expect.objectContaining({ id: "browser.executable", status: "fail" }),
        expect.objectContaining({ id: "browser.visual-baselines", status: "fail" }),
        expect.objectContaining({ id: "agent.planner", status: "fail" }),
      ]),
    );
    expect(
      report.checks
        .filter((check) => check.status === "fail")
        .every((check) => Boolean(check.remediation)),
    ).toBe(true);
  });
});
