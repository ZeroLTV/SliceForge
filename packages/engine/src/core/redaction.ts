import { minimatch } from "minimatch";

const TOKEN_PATTERNS = [
  /\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b/gi,
];

const ASSIGNMENT_PATTERN =
  /(\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd|secret)\b\s*[=:]\s*)([^\s,;"']+|"[^"]*"|'[^']*')/gi;

export function redactText(value: string, secrets: string[] = []): string {
  let output = value;
  for (const secret of secrets.filter((item) => item.length >= 4)) {
    output = output.split(secret).join("[REDACTED]");
  }
  for (const pattern of TOKEN_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  output = output.replace(
    /-----BEGIN [^-]*(?:PRIVATE KEY|CERTIFICATE)-----[\s\S]*?-----END [^-]*(?:PRIVATE KEY|CERTIFICATE)-----/g,
    "[REDACTED PEM BLOCK]",
  );
  return output.replace(ASSIGNMENT_PATTERN, "$1[REDACTED]");
}

export function redactDiff(value: string, protectedPatterns: string[]): string {
  let redactFile = false;
  const lines = value.split(/(?<=\n)/);
  return redactText(
    lines
      .map((line) => {
        if (line.startsWith("diff --git ")) {
          const match = /^diff --git a\/(.+) b\/(.+)\r?\n?$/.exec(line);
          const candidates = match ? [match[1], match[2]] : [];
          redactFile = candidates.some((file) =>
            protectedPatterns.some((pattern) => minimatch(file, pattern, { dot: true })),
          );
          return redactFile
            ? `${line.trimEnd()}\n[SliceForge redacted protected-file diff]\n`
            : line;
        }
        return redactFile ? "" : line;
      })
      .join(""),
  );
}
