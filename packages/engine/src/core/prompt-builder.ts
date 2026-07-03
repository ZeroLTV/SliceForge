import * as fs from "fs";
import { logger } from "../utils/logger.js";

export interface PromptContext {
  [key: string]: string | undefined;
}

export function buildPrompt(
  templatePath: string,
  context: PromptContext,
): string {
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Prompt template not found: ${templatePath}`);
  }

  let prompt = fs.readFileSync(templatePath, "utf8");

  for (const [key, value] of Object.entries(context)) {
    const placeholder = `{{${key}}}`;
    const replacement = value || "";
    prompt = prompt.split(placeholder).join(replacement);
  }

  const remainingPlaceholderRegex = /\{\{(\w+)\}\}/gi;
  let match: RegExpExecArray | null;
  const missedKeys: string[] = [];
  while ((match = remainingPlaceholderRegex.exec(prompt)) !== null) {
    missedKeys.push(match[1]);
  }

  if (missedKeys.length > 0) {
    logger.debug(
      `Cleaned up unpopulated placeholders in prompt template: ${[...new Set(missedKeys)].join(", ")}`,
    );
    prompt = prompt.replace(remainingPlaceholderRegex, "");
  }

  return prompt;
}
