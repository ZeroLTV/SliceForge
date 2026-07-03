import { Slice } from "../core/backlog.js";
import { SliceForgeConfig } from "../core/config.js";
import { AgentAdapter, AgentSignal } from "../agents/base-agent.js";
import { buildPrompt } from "../core/prompt-builder.js";
import { getDiff, getChangedFiles } from "../utils/git.js";
import { logger } from "../utils/logger.js";
import { resolveTemplatePath, ensureTemplateExists } from "../utils/template-resolver.js";

export async function runAiReviewGate(
  slice: Slice,
  config: SliceForgeConfig,
  projectRoot: string,
  agentAdapter: AgentAdapter,
  checksPassed: boolean,
  browserTestPassed: boolean,
): Promise<{ pass: boolean; log: string }> {
  logger.step(`Running AI Code Review gate for slice ${slice.id}`);

  const templatePath = resolveTemplatePath(projectRoot, "reviewer");
  ensureTemplateExists(
    templatePath,
    "# Reviewer Agent\n\nReview changes for slice: {{SLICE_ID}}.\nExpect signal: REVIEW_PASS\n",
  );

  const diffContext = await getDiff(projectRoot);
  const changedFilesList = (await getChangedFiles(projectRoot))
    .map((f) => `- ${f}`)
    .join("\n");

  const prompt = buildPrompt(templatePath, {
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

  const pass = result.signal === AgentSignal.REVIEW_PASS;
  if (pass) {
    logger.success("AI Code Review gate passed.");
  } else {
    logger.error(
      `AI Code Review gate failed. Agent signal: ${result.signal}`,
    );
  }

  return { pass, log: result.output };
}
