import { Slice } from "../core/backlog.js";
import { SliceForgeConfig } from "../core/config.js";
import { AgentAdapter, AgentSignal } from "../agents/base-agent.js";
import { buildPrompt } from "../core/prompt-builder.js";
import { logger } from "../utils/logger.js";
import { resolveTemplatePath, ensureTemplateExists } from "../utils/template-resolver.js";

export async function runBrowserTestGate(
  slice: Slice,
  config: SliceForgeConfig,
  projectRoot: string,
  agentAdapter: AgentAdapter,
): Promise<{ pass: boolean; log: string }> {
  logger.step(`Running browser test gate for slice ${slice.id}`);

  if (!config.loop.browserTest.required) {
    logger.info("Browser test skipped (loop.browserTest.required = false)");
    return { pass: true, log: "Skipped via config" };
  }

  const templatePath = resolveTemplatePath(projectRoot, "tester");
  ensureTemplateExists(
    templatePath,
    "# Browser Tester Agent\n\nRun Playwright test cases for slice: {{SLICE_ID}}.\nExpect signal: BROWSER_TEST_PASS\n",
  );

  const webPort = config.stack.web?.port || 3000;
  const webUrl = `http://localhost:${webPort}`;

  const prompt = buildPrompt(templatePath, {
    SLICE_ID: slice.id,
    ACCEPTANCE_TAGS: (slice.acceptance || []).join(", "),
    STACK_URL: webUrl,
  });

  logger.info("Invoking Browser Tester Agent...");
  const result = await agentAdapter.run(prompt, {
    cwd: projectRoot,
    timeoutMs: config.agent.timeoutMs || 300000,
    model: config.agent.model,
  });

  const pass = result.signal === AgentSignal.BROWSER_TEST_PASS;
  if (pass) {
    logger.success("Browser testing functional gate passed.");
  } else {
    logger.error(
      `Browser testing functional gate failed. Agent signal: ${result.signal}`,
    );
  }

  return { pass, log: result.output };
}
