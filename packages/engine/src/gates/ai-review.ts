import { Slice } from "../core/backlog.js";
import { SliceForgeConfig } from "../core/config.js";
import { AgentAdapter } from "../agents/base-agent.js";
import { buildPrompt } from "../core/prompt-builder.js";
import { getDiff, getChangedFiles } from "../utils/git.js";
import { logger } from "../utils/logger.js";
import * as path from "path";
import * as fs from "fs";

export async function runAiReviewGate(
  slice: Slice,
  config: SliceForgeConfig,
  projectRoot: string,
  agentAdapter: AgentAdapter,
  checksPassed: boolean,
  browserTestPassed: boolean,
): Promise<{ pass: boolean; log: string }> {
  logger.step(`Running AI Code Review gate for slice ${slice.id}`);

  const templatePath = path.join(projectRoot, "packages/engine/templates/reviewer.md");
  const fallbackTemplatePath = path.join(projectRoot, "templates/reviewer.md");
  const actualTemplatePath = fs.existsSync(templatePath) ? templatePath : fallbackTemplatePath;

  if (!fs.existsSync(actualTemplatePath)) {
    fs.mkdirSync(path.dirname(actualTemplatePath), { recursive: true });
    fs.writeFileSync(
      actualTemplatePath,
      "# Reviewer Agent\n\nReview changes for slice: {{SLICE_ID}}.\nExpect signal: REVIEW_PASS\n",
      "utf8",
    );
  }

  // Gather diff and changed files list
  const diffContext = await getDiff(projectRoot);
  const changedFilesList = (await getChangedFiles(projectRoot)).map(f => `- ${f}`).join("\n");

  const prompt = buildPrompt(actualTemplatePath, {
    SLICE_ID: slice.id,
    DIFF_CONTEXT: diffContext,
    CHANGED_FILES: changedFilesList || "(No files changed)",
    CHECKS_SUMMARY: checksPassed ? "PASS" : "FAIL",
    BROWSER_TEST_SUMMARY: browserTestPassed ? "PASS" : "FAIL",
  });

  logger.info("Invoking AI Reviewer Agent...");
  const result = await agentAdapter.run(prompt, {
    cwd: projectRoot,
    timeoutMs: config.agent.timeoutMs || 300000,
    model: config.agent.model,
  });

  const pass = result.signal === "REVIEW_PASS";
  if (pass) {
    logger.success("AI Code Review gate passed.");
  } else {
    logger.error(`AI Code Review gate failed. Agent signal: ${result.signal}`);
  }

  return {
    pass,
    log: result.output,
  };
}
