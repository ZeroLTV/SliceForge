import * as path from "path";
import * as fs from "fs";
import { SliceForgeConfig } from "./config.js";
import { loadBacklog, saveBacklog, pickNextSlice, markSliceDone, allSlicesPass, Slice } from "./backlog.js";
import { isDrift } from "./drift.js";
import { loadState, saveState, clearState, RunState } from "./state.js";
import { buildPrompt } from "./prompt-builder.js";
import { AgentAdapter } from "../agents/base-agent.js";
import { StackAdapter } from "../adapters/base-adapter.js";
import { CursorCliAgent } from "../agents/cursor-cli-agent.js";
import { ClaudeCodeAgent } from "../agents/claude-code-agent.js";
import { ApiAgent } from "../agents/api-agent.js";
import { NodeAdapter } from "../adapters/node-adapter.js";
import { DotnetAdapter } from "../adapters/dotnet-adapter.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { logger } from "../utils/logger.js";
import { loadAndValidateSecrets } from "../utils/secrets.js";
import {
  hasUncommittedChanges,
  resetToLastCommit,
  commitSlice,
  getChangedFiles,
  getDiff,
} from "../utils/git.js";
import { runComputationalChecks } from "../gates/checks.js";
import { startPreviewStack, stopPreviewStack } from "../gates/preview-stack.js";
import { runBrowserTestGate } from "../gates/browser-test.js";
import { runAiReviewGate } from "../gates/ai-review.js";

export function getAgentAdapter(config: SliceForgeConfig): AgentAdapter {
  switch (config.agent.type) {
    case "cursor-cli":
      return new CursorCliAgent(process.env.CURSOR_CLI_PATH);
    case "claude-code":
      return new ClaudeCodeAgent(process.env.CLAUDE_CODE_PATH);
    case "api":
      return new ApiAgent();
    default:
      throw new Error(`Unsupported agent type: ${config.agent.type}`);
  }
}

export function getStackAdapter(config: SliceForgeConfig, projectRoot: string): StackAdapter {
  switch (config.stack.type) {
    case "node":
      return new NodeAdapter(config, projectRoot);
    case "dotnet":
      return new DotnetAdapter(config, projectRoot);
    default:
      throw new Error(`Unsupported stack type: ${config.stack.type}`);
  }
}

export async function runRalphLoop(
  config: SliceForgeConfig,
  projectRoot: string,
  runOnce: boolean = false,
): Promise<void> {
  const lockPath = path.isAbsolute(config.paths.lock)
    ? config.paths.lock
    : path.join(projectRoot, config.paths.lock);

  const statePath = path.isAbsolute(config.paths.state)
    ? config.paths.state
    : path.join(projectRoot, config.paths.state);

  const backlogPath = path.isAbsolute(config.paths.backlog)
    ? config.paths.backlog
    : path.join(projectRoot, config.paths.backlog);

  const guardrailsPath = path.isAbsolute(config.paths.guardrails)
    ? config.paths.guardrails
    : path.join(projectRoot, config.paths.guardrails);

  const testCasesDir = path.isAbsolute(config.paths.testCases)
    ? config.paths.testCases
    : path.join(projectRoot, config.paths.testCases);

  logger.section(`Starting SliceForge Ralph Loop for: ${config.project}`);

  // 1. Acquire execution lock
  acquireLock(lockPath);

  try {
    // 2. Validate environment & API keys
    loadAndValidateSecrets(projectRoot, config.agent.type);

    let state = loadState(statePath);

    // If runner is in pending human approval state, tell user
    if (state.status === "pending_approval") {
      logger.warn(
        `Slice ${state.currentSliceId} is currently pending human approval. Run 'sliceforge approve <sliceId>' to proceed.`,
      );
      return;
    }

    const backlog = loadBacklog(backlogPath);

    if (allSlicesPass(backlog)) {
      logger.success("All slices in the backlog have passed. Loop complete!");
      clearState(statePath);
      return;
    }

    const agentAdapter = getAgentAdapter(config);
    const stackAdapter = getStackAdapter(config, projectRoot);

    const maxIterations = runOnce ? 1 : config.loop.maxIterations;
    let iteration = 0;

    while (iteration < maxIterations) {
      if (allSlicesPass(backlog)) {
        logger.success("All slices successfully implemented and verified!");
        clearState(statePath);
        break;
      }

      const slice = pickNextSlice(backlog);
      if (!slice) {
        logger.success("No more slices to implement.");
        clearState(statePath);
        break;
      }

      iteration++;
      logger.section(`Ralph Loop Iteration ${iteration} (Slice ID: ${slice.id})`);

      // Initialize state for the picked slice
      state.currentSliceId = slice.id;
      state.status = "running";
      const sliceRetries = state.retriesPerSlice[slice.id] || 0;

      if (sliceRetries >= config.loop.maxRetriesPerSlice) {
        const errorMsg = `Slice ${slice.id} has failed ${sliceRetries} times, which exceeds the max retries limit (${config.loop.maxRetriesPerSlice}). Escalating and aborting loop.`;
        logger.error(errorMsg);
        state.status = "running"; // reset to allow run again
        saveState(statePath, state);
        throw new Error(errorMsg);
      }

      // Check Drift
      const acceptanceTags = slice.acceptance || [];
      let drifted = false;
      if (config.loop.testCaseGate !== "skip") {
        for (const tag of acceptanceTags) {
          const docPaths = slice.docs || [];
          if (isDrift(tag, docPaths, projectRoot, testCasesDir)) {
            drifted = true;
            logger.warn(`Doc drift or missing test cases detected for tag '${tag}'.`);
          }
        }
      }

      if (drifted && config.loop.testCaseGate === "required") {
        const errorMsg = `Drift detected for slice ${slice.id}. Run 'sliceforge testgen' to regenerate test cases before building code.`;
        logger.error(errorMsg);
        throw new Error(errorMsg);
      }

      // Rollback uncommitted local changes from previous failed gate run
      if (await hasUncommittedChanges(projectRoot)) {
        logger.warn("Dirty working tree detected. Performing git rollback to clean state...");
        await resetToLastCommit(projectRoot);
      }

      // Load guardrails history if any to pass to prompt builder
      let guardrailsContent = "";
      if (fs.existsSync(guardrailsPath)) {
        guardrailsContent = fs.readFileSync(guardrailsPath, "utf8");
      }

      // Implementer Prompt Template resolving
      const templatePath = path.join(projectRoot, "packages/engine/templates/implementer.md");
      const fallbackTemplatePath = path.join(projectRoot, "templates/implementer.md");
      const actualTemplatePath = fs.existsSync(templatePath) ? templatePath : fallbackTemplatePath;

      if (!fs.existsSync(actualTemplatePath)) {
        fs.mkdirSync(path.dirname(actualTemplatePath), { recursive: true });
        fs.writeFileSync(
          actualTemplatePath,
          "# Implementer Agent\n\nImplement backlog slice: {{SLICE_ID}}\nDescription: {{SLICE_DESCRIPTION}}\nExpect signal: SLICE_DONE\n",
          "utf8",
        );
      }

      const prompt = buildPrompt(actualTemplatePath, {
        SLICE_ID: slice.id,
        SLICE_DESCRIPTION: slice.description,
        DOCS_LIST: (slice.docs || []).join("\n"),
        ACCEPTANCE_TAGS: (slice.acceptance || []).join(", "),
        PRIOR_FAILURES: guardrailsContent,
        COMPLETION_ARTIFACTS: (slice.completionArtifacts || []).join("\n"),
      });

      logger.info(`Running Implementer Agent for slice ${slice.id}...`);
      const agentResult = await agentAdapter.run(prompt, {
        cwd: projectRoot,
        timeoutMs: config.agent.timeoutMs || 600000,
        model: config.agent.model,
      });

      // Update API Token usage statistics
      if (agentResult.usage) {
        state.costAccumulated.inputTokens += agentResult.usage.inputTokens;
        state.costAccumulated.outputTokens += agentResult.usage.outputTokens;
        state.costAccumulated.estimatedCostUSD =
          (state.costAccumulated.estimatedCostUSD || 0) + (agentResult.usage.estimatedCostUSD || 0);
        logger.info(
          `Accumulated Token usage: Input=${state.costAccumulated.inputTokens}, Output=${state.costAccumulated.outputTokens} ($${state.costAccumulated.estimatedCostUSD.toFixed(3)})`,
        );
      }

      if (agentResult.signal !== "SLICE_DONE") {
        logger.error(`Implementer Agent failed with signal: ${agentResult.signal}. Retrying.`);
        state.retriesPerSlice[slice.id] = sliceRetries + 1;
        
        // Append failure details to guardrails log
        fs.appendFileSync(
          guardrailsPath,
          `\n\n## [${new Date().toISOString()}] Slice ${slice.id} Implementation Error:\n${agentResult.output}\n`,
          "utf8",
        );

        saveState(statePath, state);
        if (runOnce) break;
        continue;
      }

      // --- Gates validation phase ---
      logger.info("Implementation done. Starting gates verification...");
      state.gatesCompleted = [];

      // Gate 1: Computational Checks
      const checkResult = await runComputationalChecks(slice, config, projectRoot, stackAdapter);
      if (!checkResult.pass) {
        state.retriesPerSlice[slice.id] = sliceRetries + 1;
        const failuresLog = checkResult.failures.map((f) => `- [${f.type}] ${f.message}: ${f.details || ""}`).join("\n");
        fs.appendFileSync(
          guardrailsPath,
          `\n\n## [${new Date().toISOString()}] Computational Check Failures (Slice ${slice.id}):\n${failuresLog}\n`,
          "utf8",
        );
        saveState(statePath, state);
        if (runOnce) break;
        continue;
      }
      state.gatesCompleted.push("checks");
      saveState(statePath, state);

      // Gate 2: Preview stack & E2E Browser checks
      let browserTestPassed = true;
      if (config.loop.browserTest.required) {
        const requirePreview = config.loop.browserTest.requirePreviewStack;
        try {
          if (requirePreview) {
            await startPreviewStack(config, stackAdapter);
          }

          const browserResult = await runBrowserTestGate(slice, config, projectRoot, agentAdapter);
          browserTestPassed = browserResult.pass;

          if (!browserTestPassed) {
            state.retriesPerSlice[slice.id] = sliceRetries + 1;
            fs.appendFileSync(
              guardrailsPath,
              `\n\n## [${new Date().toISOString()}] Browser Functional Test Failures (Slice ${slice.id}):\n${browserResult.log}\n`,
              "utf8",
            );
          }
        } catch (err: any) {
          browserTestPassed = false;
          logger.error(`Error during browser testing gate: ${err.message}`);
          state.retriesPerSlice[slice.id] = sliceRetries + 1;
          fs.appendFileSync(
            guardrailsPath,
            `\n\n## [${new Date().toISOString()}] Browser Test Gate Error (Slice ${slice.id}):\n${err.message}\n`,
            "utf8",
          );
        } finally {
          if (requirePreview) {
            await stopPreviewStack(stackAdapter);
          }
        }
      }

      if (!browserTestPassed) {
        saveState(statePath, state);
        if (runOnce) break;
        continue;
      }
      state.gatesCompleted.push("browser");
      saveState(statePath, state);

      // Gate 3: AI Review Gate
      const reviewResult = await runAiReviewGate(
        slice,
        config,
        projectRoot,
        agentAdapter,
        checkResult.pass,
        browserTestPassed,
      );

      if (!reviewResult.pass) {
        state.retriesPerSlice[slice.id] = sliceRetries + 1;
        fs.appendFileSync(
          guardrailsPath,
          `\n\n## [${new Date().toISOString()}] AI Review Rejected (Slice ${slice.id}):\n${reviewResult.log}\n`,
          "utf8",
        );
        saveState(statePath, state);
        if (runOnce) break;
        continue;
      }
      state.gatesCompleted.push("review");
      saveState(statePath, state);

      // checkHumanApproval Hook
      const requireApprovalList = config.loop.requireHumanApproval || [];
      const hasMatchingTag = (slice.tags || []).some((tag) => requireApprovalList.includes(tag));

      if (hasMatchingTag) {
        logger.section(`HUMAN APPROVAL REQUIRED: Slice ${slice.id}`);
        logger.warn(
          `Slice ${slice.id} passed all validation gates, but matches approval tags. Exiting loop.`,
        );
        logger.warn(`Run 'sliceforge approve ${slice.id}' to confirm and commit the slice.`);
        state.status = "pending_approval";
        saveState(statePath, state);
        break;
      }

      // No human approval required, commit directly
      logger.success(`Slice ${slice.id} successfully implemented! Committing to git...`);
      markSliceDone(backlog, slice.id);
      saveBacklog(backlogPath, backlog);

      await commitSlice(projectRoot, slice.id, `aih/slice-${slice.id} completed successfully`);

      state.retriesPerSlice[slice.id] = 0; // Reset retries
      saveState(statePath, state);

      if (runOnce) break;
    }
  } finally {
    // 12. Release lock
    releaseLock(lockPath);
  }
}

export async function approveSlice(config: SliceForgeConfig, projectRoot: string, sliceId: string): Promise<void> {
  const statePath = path.isAbsolute(config.paths.state)
    ? config.paths.state
    : path.join(projectRoot, config.paths.state);

  const backlogPath = path.isAbsolute(config.paths.backlog)
    ? config.paths.backlog
    : path.join(projectRoot, config.paths.backlog);

  const state = loadState(statePath);

  if (state.status !== "pending_approval" || state.currentSliceId !== sliceId) {
    throw new Error(`Slice ${sliceId} is not currently pending human approval.`);
  }

  logger.info(`Approving slice ${sliceId}...`);

  const backlog = loadBacklog(backlogPath);
  markSliceDone(backlog, sliceId);
  saveBacklog(backlogPath, backlog);

  await commitSlice(projectRoot, sliceId, `aih/slice-${sliceId} approved and completed`);

  state.status = "running";
  state.retriesPerSlice[sliceId] = 0;
  saveState(statePath, state);

  logger.success(`Slice ${sliceId} approved and committed.`);
}
