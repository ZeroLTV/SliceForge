import * as fs from "fs";
import * as path from "path";

const TEMPLATE_PATHS = {
  implementer: "implementer.md",
  testgen: "testgen.md",
  tester: "tester.md",
  reviewer: "reviewer.md",
} as const;

type TemplateName = keyof typeof TEMPLATE_PATHS;

export function resolveTemplatePath(
  projectRoot: string,
  templateName: TemplateName,
): string {
  const templateFile = TEMPLATE_PATHS[templateName];

  const primaryPath = path.join(projectRoot, "packages/engine/templates", templateFile);
  const fallbackPath = path.join(projectRoot, "templates", templateFile);

  if (fs.existsSync(primaryPath)) {
    return primaryPath;
  }

  if (fs.existsSync(fallbackPath)) {
    return fallbackPath;
  }

  const dirPath = path.dirname(fallbackPath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  return fallbackPath;
}

export function ensureTemplateExists(templatePath: string, defaultContent: string): void {
  if (fs.existsSync(templatePath)) {
    return;
  }

  const dirPath = path.dirname(templatePath);
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  fs.writeFileSync(templatePath, defaultContent, "utf8");
}
