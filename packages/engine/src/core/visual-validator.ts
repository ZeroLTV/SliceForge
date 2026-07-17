import * as fs from "fs";
import * as path from "path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { BrowserVisualConfig, VisualManifest } from "./contracts.js";
import { createValidator, loadSchema } from "./schema-loader.js";

const manifestValidator = createValidator(loadSchema("../schemas/visual-manifest.schema.json"));

export interface VisualComparison {
  id: string;
  screenshot: string;
  baseline?: string;
  diff?: string;
  diffPixels?: number;
  diffRatio?: number;
}

export interface VisualValidationResult {
  artifacts: string[];
  comparisons: VisualComparison[];
  failures: string[];
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function regularFile(
  worktreeRoot: string,
  configuredPath: string,
  label: string,
  allowedRoot?: string,
): string {
  if (!configuredPath || configuredPath.includes("\0") || path.isAbsolute(configuredPath)) {
    throw new Error(`${label} must be a safe worktree-relative path.`);
  }
  const absolute = path.resolve(worktreeRoot, configuredPath);
  if (!inside(worktreeRoot, absolute)) throw new Error(`${label} escapes the worktree.`);
  if (allowedRoot && !inside(allowedRoot, absolute)) {
    throw new Error(`${label} is outside the configured visual artifact directory.`);
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file, not a symlink.`);
  }
  const realRoot = fs.realpathSync.native(worktreeRoot);
  const realFile = fs.realpathSync.native(absolute);
  if (!inside(realRoot, realFile)) throw new Error(`${label} resolves outside the worktree.`);
  return absolute;
}

function readPng(filePath: string, maxBytes: number, label: string): PNG {
  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes.`);
  try {
    return PNG.sync.read(fs.readFileSync(filePath), { checkCRC: true });
  } catch (error) {
    throw new Error(
      `${label} is not a valid PNG: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export function validateVisualManifest(
  worktreeRoot: string,
  config: BrowserVisualConfig,
): VisualValidationResult {
  const artifactRoot = path.resolve(worktreeRoot, config.artifactDirectory);
  const artifactStat = fs.lstatSync(artifactRoot);
  if (!artifactStat.isDirectory() || artifactStat.isSymbolicLink()) {
    throw new Error("Visual artifactDirectory must be a regular directory, not a symlink.");
  }
  const realWorktree = fs.realpathSync.native(worktreeRoot);
  const realArtifactRoot = fs.realpathSync.native(artifactRoot);
  if (!inside(realWorktree, realArtifactRoot)) {
    throw new Error("Visual artifactDirectory resolves outside the worktree.");
  }
  const manifestFile = regularFile(
    worktreeRoot,
    config.manifestPath,
    "Visual manifest",
    artifactRoot,
  );
  if (fs.statSync(manifestFile).size > 2 * 1024 * 1024) {
    throw new Error("Visual manifest exceeds 2 MiB.");
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch (error) {
    throw new Error(
      `Visual manifest is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!manifestValidator(value)) {
    const details = (manifestValidator.errors ?? [])
      .map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("; ");
    throw new Error(`Visual manifest schema validation failed: ${details}`);
  }
  const manifest = value as VisualManifest;
  const byId = new Map<string, VisualManifest["viewports"][number]>();
  for (const viewport of manifest.viewports) {
    if (byId.has(viewport.id)) throw new Error(`Duplicate visual viewport id: ${viewport.id}.`);
    byId.set(viewport.id, viewport);
  }
  const result: VisualValidationResult = {
    artifacts: [config.manifestPath],
    comparisons: [],
    failures: [],
  };
  for (const required of config.requiredViewports) {
    const viewport = byId.get(required.id);
    if (!viewport) {
      result.failures.push(`Required visual viewport '${required.id}' is missing.`);
      continue;
    }
    if (viewport.width !== required.width || viewport.height !== required.height) {
      result.failures.push(
        `Viewport '${required.id}' expected ${required.width}x${required.height}, received ${viewport.width}x${viewport.height}.`,
      );
      continue;
    }
    if (viewport.width * viewport.height > 20_000_000) {
      result.failures.push(`Viewport '${required.id}' exceeds the 20 megapixel safety limit.`);
      continue;
    }
    try {
      const screenshotFile = regularFile(
        worktreeRoot,
        viewport.screenshot,
        `Viewport '${required.id}' screenshot`,
        artifactRoot,
      );
      if (path.extname(screenshotFile).toLowerCase() !== ".png") {
        throw new Error(`Viewport '${required.id}' screenshot must use PNG format.`);
      }
      const screenshot = readPng(
        screenshotFile,
        config.maxScreenshotBytes,
        `Viewport '${required.id}' screenshot`,
      );
      if (screenshot.width !== viewport.width || screenshot.height !== viewport.height) {
        throw new Error(
          `Viewport '${required.id}' screenshot dimensions are ${screenshot.width}x${screenshot.height}, expected ${viewport.width}x${viewport.height}.`,
        );
      }
      result.artifacts.push(viewport.screenshot);
      const comparison: VisualComparison = { id: required.id, screenshot: viewport.screenshot };
      if (config.baselineDirectory) {
        const baselineRelative = path
          .join(config.baselineDirectory, `${required.id}.png`)
          .replace(/\\/g, "/");
        const baselineFile = regularFile(
          worktreeRoot,
          baselineRelative,
          `Viewport '${required.id}' baseline`,
        );
        const baseline = readPng(
          baselineFile,
          config.maxScreenshotBytes,
          `Viewport '${required.id}' baseline`,
        );
        comparison.baseline = baselineRelative;
        if (baseline.width !== screenshot.width || baseline.height !== screenshot.height) {
          throw new Error(
            `Viewport '${required.id}' baseline dimensions ${baseline.width}x${baseline.height} do not match screenshot ${screenshot.width}x${screenshot.height}.`,
          );
        }
        const diff = new PNG({ width: screenshot.width, height: screenshot.height });
        const diffPixels = pixelmatch(
          baseline.data,
          screenshot.data,
          diff.data,
          screenshot.width,
          screenshot.height,
          { threshold: config.pixelThreshold },
        );
        const diffRatio = diffPixels / (screenshot.width * screenshot.height);
        comparison.diffPixels = diffPixels;
        comparison.diffRatio = diffRatio;
        if (diffPixels > 0) {
          const diffRelative = path
            .join(config.artifactDirectory, "diff", `${required.id}.png`)
            .replace(/\\/g, "/");
          const diffFile = path.resolve(worktreeRoot, diffRelative);
          fs.mkdirSync(path.dirname(diffFile), { recursive: true });
          fs.writeFileSync(diffFile, PNG.sync.write(diff));
          comparison.diff = diffRelative;
          result.artifacts.push(diffRelative);
        }
        if (diffRatio > config.maxDiffRatio) {
          result.failures.push(
            `Viewport '${required.id}' visual diff ${(diffRatio * 100).toFixed(3)}% exceeds ${(config.maxDiffRatio * 100).toFixed(3)}%.`,
          );
        }
      }
      result.comparisons.push(comparison);
    } catch (error) {
      result.failures.push(error instanceof Error ? error.message : String(error));
    }
    if (config.requireNoRuntimeErrors && viewport.runtimeErrors.length) {
      result.failures.push(
        `Viewport '${required.id}' reported runtime errors: ${viewport.runtimeErrors.join("; ")}`,
      );
    }
    if (config.requireNoOverflow && viewport.overflow.length) {
      result.failures.push(
        `Viewport '${required.id}' reported overflow: ${viewport.overflow.join("; ")}`,
      );
    }
    if (config.requireAccessibility && viewport.accessibilityViolations.length) {
      result.failures.push(
        `Viewport '${required.id}' reported accessibility violations: ${viewport.accessibilityViolations.map((item) => `${item.id} (${item.impact})`).join("; ")}`,
      );
    }
    if (config.requireAssets && viewport.missingAssets.length) {
      result.failures.push(
        `Viewport '${required.id}' reported missing assets: ${viewport.missingAssets.join("; ")}`,
      );
    }
  }
  return result;
}
