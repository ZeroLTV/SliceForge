import * as fs from "fs";
import * as path from "path";
import { minimatch } from "minimatch";

function normalize(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function assertSafeRelative(relativePath: string): void {
  const normalized = normalize(relativePath);
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe project-relative path: ${relativePath}`);
  }
}

export function validateChangedPaths(
  changedPaths: string[],
  allowedPatterns: string[],
  protectedPatterns: string[],
): string[] {
  const violations: string[] = [];
  for (const changedPath of changedPaths) {
    assertSafeRelative(changedPath);
    const normalized = normalize(changedPath);
    if (protectedPatterns.some((pattern) => minimatch(normalized, pattern, { dot: true }))) {
      violations.push(`${normalized}: protected path`);
      continue;
    }
    if (!allowedPatterns.some((pattern) => minimatch(normalized, pattern, { dot: true }))) {
      violations.push(`${normalized}: outside allowedPaths`);
    }
  }
  return violations;
}

export function validateArtifacts(worktreeRoot: string, requiredArtifacts: string[]): string[] {
  const failures: string[] = [];
  for (const artifact of requiredArtifacts) {
    assertSafeRelative(artifact);
    const absolutePath = path.resolve(worktreeRoot, artifact);
    const relative = path.relative(worktreeRoot, absolutePath);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      failures.push(`${artifact}: escapes worktree`);
      continue;
    }
    if (!fs.existsSync(absolutePath)) failures.push(`${artifact}: missing`);
    else if (fs.lstatSync(absolutePath).isSymbolicLink())
      failures.push(`${artifact}: symlink artifacts are not allowed`);
    else {
      const realRoot = fs.realpathSync.native(worktreeRoot);
      const realArtifact = fs.realpathSync.native(absolutePath);
      const realRelative = path.relative(realRoot, realArtifact);
      if (
        realRelative === ".." ||
        realRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelative)
      ) {
        failures.push(`${artifact}: resolves through a symlink outside worktree`);
      }
    }
  }
  return failures;
}

export function validateDocumentation(worktreeRoot: string, documents: string[]): string[] {
  const failures = validateArtifacts(worktreeRoot, documents);
  for (const documentPath of documents) {
    if (failures.some((failure) => failure.startsWith(`${documentPath}:`))) continue;
    if (!/\.mdx?$/i.test(documentPath)) continue;
    const absoluteDocument = path.resolve(worktreeRoot, documentPath);
    const content = fs.readFileSync(absoluteDocument, "utf8");
    if (!content.trim()) {
      failures.push(`${documentPath}: documentation is empty`);
      continue;
    }
    const links = content.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g);
    for (const match of links) {
      const rawTarget = match[1].replace(/^<|>$/g, "");
      if (/^(https?:|mailto:|#)/i.test(rawTarget)) continue;
      if (/^[a-z][a-z0-9+.-]*:/i.test(rawTarget) || path.isAbsolute(rawTarget)) {
        failures.push(`${documentPath}: unsafe local link '${rawTarget}'`);
        continue;
      }
      let decoded: string;
      try {
        decoded = decodeURIComponent(rawTarget.split(/[?#]/, 1)[0]);
      } catch {
        failures.push(`${documentPath}: invalid encoded link '${rawTarget}'`);
        continue;
      }
      if (!decoded) continue;
      const target = path.resolve(path.dirname(absoluteDocument), decoded);
      const relative = path.relative(worktreeRoot, target);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        failures.push(`${documentPath}: link escapes worktree '${rawTarget}'`);
      } else if (!fs.existsSync(target)) {
        failures.push(`${documentPath}: broken local link '${rawTarget}'`);
      } else if (fs.lstatSync(target).isSymbolicLink()) {
        failures.push(`${documentPath}: local link targets a symlink '${rawTarget}'`);
      }
    }
  }
  return failures;
}
