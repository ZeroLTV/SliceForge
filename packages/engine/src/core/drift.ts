import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger.js";

export function computeFileHash(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    return "";
  }
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function computeTagFingerprint(tag: string, docPaths: string[], projectRoot: string): string {
  const hash = crypto.createHash("sha256");
  // Sort paths to ensure fingerprint is deterministic
  const sortedPaths = [...docPaths].sort();

  let hasDocs = false;
  for (const docPath of sortedPaths) {
    const absolutePath = path.isAbsolute(docPath) ? docPath : path.join(projectRoot, docPath);
    if (fs.existsSync(absolutePath)) {
      const fileHash = computeFileHash(absolutePath);
      hash.update(`${docPath}:${fileHash}`);
      hasDocs = true;
    }
  }

  if (!hasDocs) {
    // If no docs, tag fingerprint is based on the tag name itself
    hash.update(`tag-name:${tag}`);
  }

  return hash.digest("hex");
}

export interface DocsFingerprintMap {
  [tag: string]: {
    fingerprint: string;
    docs: string[];
    timestamp: string;
  };
}

function loadFingerprintMap(mapPath: string): DocsFingerprintMap {
  if (!fs.existsSync(mapPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(mapPath, "utf8");
    return JSON.parse(raw);
  } catch (err: any) {
    logger.warn(`Failed to parse fingerprint map at ${mapPath}: ${err.message}. Initializing empty.`);
    return {};
  }
}

function saveFingerprintMap(mapPath: string, map: DocsFingerprintMap): void {
  try {
    const dir = path.dirname(mapPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(mapPath, JSON.stringify(map, null, 2), "utf8");
  } catch (err: any) {
    logger.error(`Failed to save fingerprint map to ${mapPath}: ${err.message}`);
  }
}

export function isDrift(
  tag: string,
  docPaths: string[],
  projectRoot: string,
  testCasesDir: string,
): boolean {
  const mapPath = path.join(testCasesDir, "testgen-docs-map.json");
  const map = loadFingerprintMap(mapPath);
  const savedEntry = map[tag];

  if (!savedEntry) {
    logger.debug(`Drift detected: No saved fingerprint entry for tag '${tag}'`);
    return true;
  }

  // Also check if the test case artifact file exists
  const testCaseFile = path.join(testCasesDir, `${tag}.json`);
  if (!fs.existsSync(testCaseFile)) {
    logger.debug(`Drift detected: Test case file not found at ${testCaseFile}`);
    return true;
  }

  const currentFp = computeTagFingerprint(tag, docPaths, projectRoot);
  const drifted = savedEntry.fingerprint !== currentFp;
  if (drifted) {
    logger.debug(`Drift detected for tag '${tag}'. Old: ${savedEntry.fingerprint}, New: ${currentFp}`);
  }
  return drifted;
}

export function updateFingerprint(
  tag: string,
  docPaths: string[],
  projectRoot: string,
  testCasesDir: string,
): void {
  const mapPath = path.join(testCasesDir, "testgen-docs-map.json");
  const map = loadFingerprintMap(mapPath);
  const currentFp = computeTagFingerprint(tag, docPaths, projectRoot);

  map[tag] = {
    fingerprint: currentFp,
    docs: docPaths,
    timestamp: new Date().toISOString(),
  };

  saveFingerprintMap(mapPath, map);
  logger.debug(`Updated fingerprint for tag '${tag}' to ${currentFp}`);
}
