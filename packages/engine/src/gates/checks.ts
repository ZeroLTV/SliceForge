import * as fs from "fs";
import * as path from "path";
import { Slice } from "../core/backlog.js";
import { SliceForgeConfig } from "../core/config.js";
import { StackAdapter } from "../adapters/base-adapter.js";
import { logger } from "../utils/logger.js";

export interface CheckFailure {
  type:
    | "forbidden_pattern"
    | "missing_artifact"
    | "build_error"
    | "lint_error"
    | "test_error";
  message: string;
  details?: string;
}

export async function runComputationalChecks(
  slice: Slice,
  config: SliceForgeConfig,
  projectRoot: string,
  stackAdapter: StackAdapter,
): Promise<{ pass: boolean; failures: CheckFailure[] }> {
  const failures: CheckFailure[] = [];

  logger.step("Running computational checks");

  const forbiddenPatterns = config.checks.forbiddenPatterns || [];
  for (const rule of forbiddenPatterns) {
    logger.debug(`Checking forbidden pattern rule: ${rule.id}`);
    const regex = new RegExp(rule.pattern);

    for (const searchPath of rule.paths) {
      const fullPath = path.isAbsolute(searchPath)
        ? searchPath
        : path.join(projectRoot, searchPath);
      if (!fs.existsSync(fullPath)) continue;

      const checkFileOrDir = (targetPath: string) => {
        const stat = fs.statSync(targetPath);
        if (stat.isDirectory()) {
          const files = fs.readdirSync(targetPath);
          for (const file of files) {
            checkFileOrDir(path.join(targetPath, file));
          }
        } else if (stat.isFile()) {
          try {
            const content = fs.readFileSync(targetPath, "utf8");
            if (regex.test(content)) {
              logger.warn(
                `Forbidden pattern [${rule.id}] matches in ${targetPath}`,
              );
              failures.push({
                type: "forbidden_pattern",
                message: `Forbidden pattern matched: ${rule.message}`,
                details: `File: ${path.relative(projectRoot, targetPath)} (Rule: ${rule.id})`,
              });
            }
          } catch (err) {
            logger.warn(
              `Could not read file for pattern check: ${targetPath} — ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      };

      checkFileOrDir(fullPath);
    }
  }

  const artifacts = slice.completionArtifacts || [];
  for (const artifact of artifacts) {
    const absolutePath = path.isAbsolute(artifact)
      ? artifact
      : path.join(projectRoot, artifact);
    if (!fs.existsSync(absolutePath)) {
      logger.warn(`Missing completion artifact: ${artifact}`);
      failures.push({
        type: "missing_artifact",
        message: `Required artifact was not created: ${artifact}`,
      });
    }
  }

  logger.info("Running build/typecheck command...");
  const buildResult = await stackAdapter.build();
  if (buildResult.exitCode !== 0) {
    logger.error(`Build failed: ${buildResult.stderr}`);
    failures.push({
      type: "build_error",
      message: "Compiler or build command failed",
      details: buildResult.stderr || buildResult.stdout,
    });
  }

  logger.info("Running lint command...");
  const lintResult = await stackAdapter.lint();
  if (lintResult.exitCode !== 0) {
    logger.warn(`Lint check failed: ${lintResult.stderr}`);
    failures.push({
      type: "lint_error",
      message: "Lint check failed",
      details: lintResult.stderr || lintResult.stdout,
    });
  }

  const unitTests = slice.testRequirements?.unit || [];
  if (unitTests.length > 0 || config.checks.commands.test.unit) {
    logger.info("Running unit tests...");
    const testResult = await stackAdapter.test("unit");
    if (testResult.exitCode !== 0) {
      logger.error(`Unit tests failed: ${testResult.stderr}`);
      failures.push({
        type: "test_error",
        message: "Unit tests failed",
        details: testResult.stderr || testResult.stdout,
      });
    }
  }

  const intTests = slice.testRequirements?.integration || [];
  if (intTests.length > 0 || config.checks.commands.test.integration) {
    logger.info("Running integration tests...");
    const testResult = await stackAdapter.test("integration");
    if (testResult.exitCode !== 0) {
      logger.error(`Integration tests failed: ${testResult.stderr}`);
      failures.push({
        type: "test_error",
        message: "Integration tests failed",
        details: testResult.stderr || testResult.stdout,
      });
    }
  }

  const pass = failures.length === 0;
  if (pass) {
    logger.success("All computational checks passed.");
  } else {
    logger.error(`${failures.length} computational checks failed.`);
  }

  return { pass, failures };
}
