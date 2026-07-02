import * as path from "path";
import * as fs from "fs";
import { SliceForgeConfig } from "./config.js";
import { loadBacklog, Slice } from "./backlog.js";
import { isDrift, updateFingerprint } from "./drift.js";
import { buildPrompt } from "./prompt-builder.js";
import { getAgentAdapter } from "./ralph-runner.js";
import { logger } from "../utils/logger.js";
import { commitSlice } from "../utils/git.js";
import { loadAndValidateSecrets } from "../utils/secrets.js";

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

  // Extract all unique requirement tags from slices
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
          // Merge unique doc paths
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
      logger.debug(`Requirement tag '${tag}' test cases are up-to-date. Skipping.`);
      continue;
    }

    processedCount++;
    logger.step(`Generating test cases for tag: ${tag}`);

    // Resolve prompt template
    const templatePath = path.join(projectRoot, "packages/engine/templates/testgen.md");
    const fallbackTemplatePath = path.join(projectRoot, "templates/testgen.md");
    const actualTemplatePath = fs.existsSync(templatePath) ? templatePath : fallbackTemplatePath;

    if (!fs.existsSync(actualTemplatePath)) {
      fs.mkdirSync(path.dirname(actualTemplatePath), { recursive: true });
      fs.writeFileSync(
        actualTemplatePath,
        "# TestGen Agent\n\nGenerate test cases for requirement tag: {{REQUIREMENT_TAG}}.\nSave JSON file to: {{ARTIFACT_PATH}}\n",
        "utf8",
      );
    }

    const testCaseFileRelative = path.join(
      path.relative(projectRoot, testCasesDir),
      `${tag}.json`,
    );

    // Read doc contents to pass in prompt
    let docsContent = "";
    for (const doc of docPaths) {
      const absPath = path.isAbsolute(doc) ? doc : path.join(projectRoot, doc);
      if (fs.existsSync(absPath)) {
        docsContent += `\n\n--- Document: ${doc} ---\n` + fs.readFileSync(absPath, "utf8");
      }
    }

    const prompt = buildPrompt(actualTemplatePath, {
      REQUIREMENT_TAG: tag,
      DOCS_CONTENT: docsContent || "(No specifications found)",
      ARTIFACT_PATH: testCaseFileRelative,
    });

    const agentResult = await agentAdapter.run(prompt, {
      cwd: projectRoot,
      timeoutMs: config.agent.timeoutMs || 300000,
      model: config.agent.model,
    });

    // Validate if test case file was created and is valid JSON
    const testCaseFile = path.join(testCasesDir, `${tag}.json`);
    if (!fs.existsSync(testCaseFile)) {
      logger.error(`TestGen Agent failed to create test case file for ${tag} at ${testCaseFile}`);
      continue;
    }

    try {
      const content = fs.readFileSync(testCaseFile, "utf8");
      JSON.parse(content); // Validate JSON format
    } catch (err: any) {
      logger.error(`Generated test cases for ${tag} contain invalid JSON: ${err.message}`);
      continue;
    }

    // Update fingerprint
    updateFingerprint(tag, docPaths, projectRoot, testCasesDir);

    // Commit generated test cases to git
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
