import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import AxeBuilder from "@axe-core/playwright";
import { chromium, type Page } from "@playwright/test";
import { afterEach, describe, expect, it, jest } from "@jest/globals";
import type {
  BrowserVisualConfig,
  VisualManifest,
  VisualViewportResult,
} from "../../src/core/contracts";
import { validateVisualManifest } from "../../src/core/visual-validator";

const roots: string[] = [];
jest.setTimeout(120_000);

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sliceforge-browser-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const viewports = [
  { id: "desktop", width: 1280, height: 720 },
  { id: "mobile", width: 390, height: 844 },
];

function html(accent = "#166534"): string {
  return `<!doctype html>
  <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Users</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; color: #111827; background: #f8fafc; font: 16px Arial, sans-serif; }
    main { width: min(960px, calc(100% - 32px)); margin: 24px auto; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 16px; }
    label { display: grid; gap: 6px; font-weight: 700; }
    input { width: 280px; max-width: 100%; padding: 10px; border: 1px solid #6b7280; }
    button { min-height: 40px; padding: 8px 14px; color: #fff; background: ${accent}; border: 0; }
    .table-wrap { margin-top: 20px; overflow-x: auto; border: 1px solid #d1d5db; background: #fff; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #e5e7eb; }
    @media (max-width: 560px) { header { align-items: stretch; flex-direction: column; } input, button { width: 100%; } }
  </style></head><body><main><header><div><h1>User management</h1><p>Search and manage active accounts.</p></div>
  <label for="search">Search users<input id="search" name="search" type="search"></label></header>
  <div class="table-wrap"><table><caption class="sr-only">User accounts</caption><thead><tr><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
  <tbody><tr><td>Alex Morgan</td><td>Active</td><td><button type="button" aria-label="Disable Alex Morgan">Disable</button></td></tr></tbody></table></div>
  </main></body></html>`;
}

async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("body *")]
      .filter(
        (element) =>
          element.scrollWidth > element.clientWidth + 1 ||
          element.getBoundingClientRect().right > document.documentElement.clientWidth + 1,
      )
      .map((element) => element.id || element.className || element.tagName.toLowerCase()),
  );
}

async function capture(root: string, content: string): Promise<VisualManifest> {
  const browser = await chromium.launch({ headless: true });
  const results: VisualViewportResult[] = [];
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const runtimeErrors: string[] = [];
      const missingAssets: string[] = [];
      page.on("pageerror", (error) => runtimeErrors.push(error.message));
      page.on("requestfailed", (request) => missingAssets.push(request.url()));
      page.on("response", (response) => {
        if (response.status() >= 400) missingAssets.push(`${response.status()} ${response.url()}`);
      });
      await page.setContent(content, { waitUntil: "load" });
      const axe = await new AxeBuilder({ page }).analyze();
      const screenshot = `artifacts/visual/${viewport.id}.png`;
      const screenshotPath = path.join(root, screenshot);
      fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({ path: screenshotPath, fullPage: false, animations: "disabled" });
      results.push({
        ...viewport,
        screenshot,
        runtimeErrors,
        overflow: await overflow(page),
        accessibilityViolations: axe.violations.map((violation) => ({
          id: violation.id,
          impact: (["minor", "moderate", "serious", "critical"].includes(violation.impact ?? "")
            ? violation.impact
            : "minor") as "minor" | "moderate" | "serious" | "critical",
          description: violation.description,
        })),
        missingAssets,
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  const manifest: VisualManifest = { schemaVersion: 1, viewports: results };
  fs.writeFileSync(
    path.join(root, "artifacts/visual/manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}

function config(): BrowserVisualConfig {
  return {
    artifactDirectory: "artifacts/visual",
    manifestPath: "artifacts/visual/manifest.json",
    baselineDirectory: "tests/visual-baselines",
    requiredViewports: viewports,
    maxDiffRatio: 0,
    pixelThreshold: 0.1,
    maxScreenshotBytes: 5 * 1024 * 1024,
    requireNoRuntimeErrors: true,
    requireNoOverflow: true,
    requireAccessibility: true,
    requireAssets: true,
  };
}

describe("real Playwright visual fixture", () => {
  it("passes approved desktop/mobile evidence and catches a seeded pixel regression", async () => {
    const root = temporaryRoot();
    await capture(root, html());
    for (const viewport of viewports) {
      const baseline = path.join(root, "tests/visual-baselines", `${viewport.id}.png`);
      fs.mkdirSync(path.dirname(baseline), { recursive: true });
      fs.copyFileSync(path.join(root, "artifacts/visual", `${viewport.id}.png`), baseline);
    }
    const approved = validateVisualManifest(root, config());
    expect(approved.failures).toEqual([]);
    expect(approved.comparisons).toHaveLength(2);

    await capture(root, html("#b91c1c"));
    const regression = validateVisualManifest(root, config());
    expect(regression.failures).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/desktop.*visual diff/i),
        expect.stringMatching(/mobile.*visual diff/i),
      ]),
    );
    expect(regression.comparisons.every((item) => (item.diffPixels ?? 0) > 0)).toBe(true);
  });
});
