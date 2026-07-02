import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger.js";

export interface PromptContext {
  [key: string]: string | undefined;
}

export function buildPrompt(templatePath: string, context: PromptContext): string {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Prompt template not found: ${templatePath}`);
  }

  let prompt = fs.readFileSync(templatePath, "utf8");

  // Simple placeholder replacement loop
  for (const [key, value] of Object.entries(context)) {
    const placeholder = `{{${key}}}`;
    const replacement = value || "";
    // Replace all occurrences of placeholder
    prompt = prompt.split(placeholder).join(replacement);
  }

  // Find remaining placeholders that were not replaced and log warning / clean them up
  const remainingPlaceholderRegex = /\{\{([A-Z0-9_]+)\}\}/gi;
  let match;
  const missedKeys: string[] = [];
  while ((match = remainingPlaceholderRegex.exec(prompt)) !== null) {
    missedKeys.push(match[1]);
  }

  if (missedKeys.length > 0) {
    logger.debug(
      `Cleaned up unpopulated placeholders in prompt template: ${[...new Set(missedKeys)].join(", ")}`,
    );
    // Replace remaining placeholders with empty string
    prompt = prompt.replace(remainingPlaceholderRegex, "");
  }

  return prompt;
}
