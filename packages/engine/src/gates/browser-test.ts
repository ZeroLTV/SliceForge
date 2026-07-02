import { Slice } from "../core/backlog.js";
import { SliceForgeConfig } from "../core/config.js";
import { AgentAdapter } from "../agents/base-agent.js";
import { buildPrompt } from "../core/prompt-builder.js";
import { logger } from "../utils/logger.js";
import * as path from "path";
import * as fs from "fs";

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

  // Find tester template path
  const templatePath = path.join(projectRoot, "packages/engine/templates/tester.md");
  const fallbackTemplatePath = path.join(projectRoot, "templates/tester.md");
  const actualTemplatePath = fs.existsSync(templatePath) ? templatePath : fallbackTemplatePath;

  if (!fs.existsSync(actualTemplatePath)) {
    // If no template is found, create a mock template
    fs.mkdirSync(path.dirname(actualTemplatePath), { recursive: true });
    fs.writeFileSync(
      actualTemplatePath,
      "# Browser Tester Agent\n\nRun Playwright test cases for slice: {{SLICE_ID}}.\nExpect signal: BROWSER_TEST_PASS\n",
      "utf8",
    );
  }

  // Get stack URLs
  const webPort = config.stack.web?.port || 3000;
  const webUrl = `http://localhost:${webPort}`;

  const prompt = buildPrompt(actualTemplatePath, {
    SLICE_ID: slice.id,
    ACCEPTANCE_TAGS: (slice.acceptance || []).join(", "),
    STACK_URL: webUrl,
  });

  logger.info("Invoking Browser Tester Agent...");
  const result = await agentAdapter.run(prompt, {
    cwd: projectRoot,
    timeoutMs: config.agent.timeoutMs || 300000, // 5 min default
    model: config.agent.model,
  });

  const pass = result.signal === "BROWSER_TEST_PASS";
  if (pass) {
    logger.success("Browser testing functional gate passed.");
  } else {
    logger.error(`Browser testing functional gate failed. Agent signal: ${result.signal}`);
  }

  return {
    pass,
    log: result.output,
  };
}
