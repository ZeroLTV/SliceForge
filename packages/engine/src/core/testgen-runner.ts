import * as path from "path";
import * as fs from "fs";
import { SliceForgeConfig } from "./config.js";
import { loadBacklog } from "./backlog.js";
import { isDrift, updateFingerprint } from "./drift.js";
import { buildPrompt } from "./prompt-builder.js";
import { getAgentAdapter } from "./ralph-runner.js";
import { logger } from "../utils/logger.js";
import { commitSlice } from "../utils/git.js";
import { loadAndValidateSecrets } from "../utils/secrets.js";
import { resolveTemplatePath, ensureTemplateExists } from "../utils/template-resolver.js";

export async function runTestGenLoop(
  config: SliceForgeConfig,
  projectRoot: string,
  runOnce: boolean = false,
): Promise<void> {
  logger.section("Starting SliceForge TestGen Loop");

  loadAndValidateSecrets(projectRoot, config.agent.type);

  const backlogPath = path.isAbsolute(config.paths.backlog)
    ? config.paths.backlog
    : path.join(projectRoot, config.paths.backlog);

  const testCasesDir = path.isAbsolute(config.paths.testCases)
    ? config.paths.testCases
    : path.join(projectRoot, config.paths.testCases);

  const backlog = loadBacklog(backlogPath);
  const agentAdapter = getAgentAdapter(config);

  const allTags = new Set<string>();
  const tagToDocPaths: Record<string, string[]> = {};

  for (const slice of backlog.slices) {
    if (slice.acceptance) {
      for (const tag of slice.acceptance) {
        allTags.add(tag);
        if (!tagToDocPaths[tag]) {
          tagToDocPaths[tag] = [];
        }
        if (slice.docs) {
          for (const doc of slice.docs) {
            if (!tagToDocPaths[tag].includes(doc)) {
              tagToDocPaths[tag].push(doc);
            }
          }
        }
      }
    }
  }

  logger.info(`Found ${allTags.size} unique requirement tags in backlog.`);

  let processedCount = 0;
  for (const tag of allTags) {
    const docPaths = tagToDocPaths[tag] || [];

    const drifted = isDrift(tag, docPaths, projectRoot, testCasesDir);
    if (!drifted) {
      logger.debug(
        `Requirement tag '${tag}' test cases are up-to-date. Skipping.`,
      );
      continue;
    }

    processedCount++;
    logger.step(`Generating test cases for tag: ${tag}`);

    const templatePath = resolveTemplatePath(projectRoot, "testgen");
    ensureTemplateExists(
      templatePath,
      "# TestGen Agent\n\nGenerate test cases for requirement tag: {{REQUIREMENT_TAG}}.\nSave JSON file to: {{ARTIFACT_PATH}}\n",
    );

    const testCaseFileRelative = path.join(
      path.relative(projectRoot, testCasesDir),
      `${tag}.json`,
    );

    let docsContent = "";
    for (const doc of docPaths) {
      const absPath = path.isAbsolute(doc)
        ? doc
        : path.join(projectRoot, doc);
      if (fs.existsSync(absPath)) {
        docsContent +=
          `\n\n--- Document: ${doc} ---\n` +
          fs.readFileSync(absPath, "utf8");
      }
    }

    const prompt = buildPrompt(templatePath, {
      REQUIREMENT_TAG: tag,
      DOCS_CONTENT: docsContent || "(No specifications found)",
      ARTIFACT_PATH: testCaseFileRelative,
    });

    void await agentAdapter.run(prompt, {
      cwd: projectRoot,
      timeoutMs: config.agent.timeoutMs || 300000,
      model: config.agent.model,
    });

    const testCaseFile = path.join(testCasesDir, `${tag}.json`);
    if (!fs.existsSync(testCaseFile)) {
      logger.error(
        `TestGen Agent failed to create test case file for ${tag} at ${testCaseFile}`,
      );
      continue;
    }

    try {
      const content = fs.readFileSync(testCaseFile, "utf8");
      JSON.parse(content) as unknown;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(
        `Generated test cases for ${tag} contain invalid JSON: ${message}`,
      );
      continue;
    }

    updateFingerprint(tag, docPaths, projectRoot, testCasesDir);

    await commitSlice(
      projectRoot,
      tag,
      `testgen: generated test cases for tag ${tag} successfully`,
    );

    logger.success(`Requirement tag '${tag}' successfully processed.`);

    if (runOnce) {
      break;
    }
  }

  if (processedCount === 0) {
    logger.success("All requirement tag test cases are up-to-date.");
  } else {
    logger.success(`Processed ${processedCount} drifted tags.`);
  }
}
