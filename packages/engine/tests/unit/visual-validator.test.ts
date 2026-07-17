import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "@jest/globals";
import { PNG } from "pngjs";
import type {
  BrowserVisualConfig,
  SliceDefinition,
  SliceForgeConfig,
  VisualManifest,
} from "../../src/core/contracts";
import { DeterministicGateRunner } from "../../src/core/gate-runner";
import { validateVisualManifest } from "../../src/core/visual-validator";

const roots: string[] = [];

function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-visual-"));
  roots.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of roots.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function png(filePath: string, width: number, height: number, pixels: number[][]): void {
  const image = new PNG({ width, height });
  for (let index = 0; index < width * height; index++) {
    const [red, green, blue, alpha = 255] = pixels[index] ?? pixels[0];
    const offset = index * 4;
    image.data[offset] = red;
    image.data[offset + 1] = green;
    image.data[offset + 2] = blue;
    image.data[offset + 3] = alpha;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, PNG.sync.write(image));
}

function visualConfig(): BrowserVisualConfig {
  return {
    artifactDirectory: "artifacts/visual",
    manifestPath: "artifacts/visual/manifest.json",
    baselineDirectory: "tests/visual-baselines",
    requiredViewports: [{ id: "desktop", width: 2, height: 2 }],
    maxDiffRatio: 0,
    pixelThreshold: 0.1,
    maxScreenshotBytes: 1024 * 1024,
    requireNoRuntimeErrors: true,
    requireNoOverflow: true,
    requireAccessibility: true,
    requireAssets: true,
  };
}

function manifest(overrides: Partial<VisualManifest["viewports"][number]> = {}): VisualManifest {
  return {
    schemaVersion: 1,
    viewports: [
      {
        id: "desktop",
        width: 2,
        height: 2,
        screenshot: "artifacts/visual/desktop.png",
        runtimeErrors: [],
        overflow: [],
        accessibilityViolations: [],
        missingAssets: [],
        ...overrides,
      },
    ],
  };
}

function writeFixture(
  directory: string,
  currentPixels: number[][],
  baselinePixels: number[][] = currentPixels,
  value: VisualManifest = manifest(),
): void {
  png(path.join(directory, "artifacts/visual/desktop.png"), 2, 2, currentPixels);
  png(path.join(directory, "tests/visual-baselines/desktop.png"), 2, 2, baselinePixels);
  fs.writeFileSync(path.join(directory, "artifacts/visual/manifest.json"), JSON.stringify(value));
}

describe("deterministic visual manifest", () => {
  it("validates viewport dimensions and an identical approved pixel baseline", () => {
    const directory = root();
    writeFixture(directory, [[20, 40, 60, 255]]);
    const result = validateVisualManifest(directory, visualConfig());
    expect(result.failures).toEqual([]);
    expect(result.comparisons).toEqual([
      expect.objectContaining({ id: "desktop", diffPixels: 0, diffRatio: 0 }),
    ]);
    expect(result.artifacts).toEqual(
      expect.arrayContaining(["artifacts/visual/manifest.json", "artifacts/visual/desktop.png"]),
    );
  });

  it("creates a deterministic diff artifact and fails when pixel ratio exceeds policy", () => {
    const directory = root();
    writeFixture(
      directory,
      [
        [255, 255, 255, 255],
        [0, 0, 0, 255],
        [0, 0, 0, 255],
        [0, 0, 0, 255],
      ],
      [[0, 0, 0, 255]],
    );
    const result = validateVisualManifest(directory, visualConfig());
    expect(result.failures).toEqual([expect.stringMatching(/visual diff 25\.000% exceeds/i)]);
    expect(result.comparisons[0]).toMatchObject({ diffPixels: 1, diffRatio: 0.25 });
    expect(fs.existsSync(path.join(directory, "artifacts/visual/diff/desktop.png"))).toBe(true);
  });

  it("fails configured runtime, overflow, accessibility and asset checks", () => {
    const directory = root();
    const value = manifest({
      runtimeErrors: ["TypeError: failed to render"],
      overflow: ["#users-table exceeds viewport by 12px"],
      accessibilityViolations: [
        { id: "button-name", impact: "serious", description: "Button has no accessible name" },
      ],
      missingAssets: ["/avatar.png"],
    });
    writeFixture(directory, [[0, 0, 0, 255]], [[0, 0, 0, 255]], value);
    const result = validateVisualManifest(directory, visualConfig());
    expect(result.failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/runtime errors/i),
        expect.stringMatching(/overflow/i),
        expect.stringMatching(/accessibility violations/i),
        expect.stringMatching(/missing assets/i),
      ]),
    );
  });

  it("rejects unsafe screenshot paths and malformed manifests", () => {
    const directory = root();
    writeFixture(
      directory,
      [[0, 0, 0, 255]],
      [[0, 0, 0, 255]],
      manifest({ screenshot: "source.png" }),
    );
    png(path.join(directory, "source.png"), 2, 2, [[0, 0, 0, 255]]);
    expect(validateVisualManifest(directory, visualConfig()).failures).toEqual([
      expect.stringMatching(/outside the configured visual artifact directory/i),
    ]);

    fs.writeFileSync(
      path.join(directory, "artifacts/visual/manifest.json"),
      JSON.stringify({ schemaVersion: 1, viewports: [{ id: "desktop" }] }),
    );
    expect(() => validateVisualManifest(directory, visualConfig())).toThrow(/schema validation/i);
  });

  it("integrates visual evidence into the deterministic browser gate", async () => {
    const directory = root();
    writeFixture(directory, [[30, 60, 90, 255]]);
    fs.writeFileSync(
      path.join(directory, "artifacts/playwright.json"),
      JSON.stringify({ stats: { unexpected: 0 } }),
    );
    const config: SliceForgeConfig = {
      schemaVersion: 1,
      project: "visual-fixture",
      agents: {
        implementer: { type: "codex" },
        testgen: { type: "codex" },
        reviewer: { type: "codex" },
      },
      targets: { app: { root: ".", preset: "generic", commands: {} } },
      isolation: { mode: "worktree" },
      gates: {
        order: ["browser"],
        browser: {
          enabled: true,
          command: { command: process.execPath, args: ["-e", "process.exit(0)"] },
          reportPath: "artifacts/playwright.json",
          visual: visualConfig(),
        },
        review: { enabled: false, advisory: true },
      },
      policies: { protectedPatterns: [], maxRetries: 0 },
      reporting: { retainRuns: 10, maxLogBytes: 65536 },
      ci: { reportOnly: true },
    };
    const slice: SliceDefinition = {
      id: "visual",
      title: "Visual gate",
      priority: 1,
      targets: ["app"],
      acceptance: [{ id: "VISUAL-1", expected: "Approved desktop rendering" }],
      allowedPaths: ["src/**"],
      requiredGates: ["browser"],
      evidence: [{ acceptanceId: "VISUAL-1", kind: "visual", source: "browser", required: true }],
    };
    const results = await new DeterministicGateRunner().run(config, slice, directory);
    expect(results).toEqual([
      expect.objectContaining({
        kind: "browser",
        status: "passed",
        summary: expect.stringMatching(/1 visual viewport/i),
        artifacts: expect.arrayContaining([
          "artifacts/playwright.json",
          "artifacts/visual/manifest.json",
          "artifacts/visual/desktop.png",
        ]),
      }),
    ]);
  });
});
