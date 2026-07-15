import * as path from "path";
import * as fs from "fs";
import { SliceForgeConfig, GitDirtyMode, GitRollbackMode } from "./config.js";
import {
  loadBacklog,
  saveBacklog,
  pickNextSlice,
  markSliceDone,
  allSlicesPass,
  Slice,
} from "./backlog.js";
import { isDrift } from "./drift.js";
import { loadState, saveState, clearState, RunState } from "./state.js";
import { buildPrompt } from "./prompt-builder.js";
import { AgentAdapter, AgentSignal } from "../agents/base-agent.js";
import { StackAdapter } from "../adapters/base-adapter.js";
import { CursorCliAgent } from "../agents/cursor-cli-agent.js";
import { ClaudeCodeAgent } from "../agents/claude-code-agent.js";
import { ApiAgent } from "../agents/api-agent.js";
import { NodeAdapter } from "../adapters/node-adapter.js";
import { DotnetAdapter } from "../adapters/dotnet-adapter.js";
import { ReactNativeAdapter } from "../adapters/react-native-adapter.js";
import { acquireLock, releaseLock } from "../utils/lock.js";
import { logger } from "../utils/logger.js";
import { loadAndValidateSecrets } from "../utils/secrets.js";
import {
  hasUncommittedChanges,
  resetToLastCommit,
  commitSlice,
  stashChanges,
  resetToSha,
  getCurrentSha,
} from "../utils/git.js";
import { runComputationalChecks } from "../gates/checks.js";
import { spawnCommand } from "../utils/shell.js";
import {
  startPreviewStack,
  stopPreviewStack,
} from "../gates/preview-stack.js";
import { runBrowserTestGate } from "../gates/browser-test.js";
import { runAiReviewGate } from "../gates/ai-review.js";
import { resolveTemplatePath, ensureTemplateExists } from "../utils/template-resolver.js";

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

export function getStackAdapter(
  config: SliceForgeConfig,
  projectRoot: string,
): StackAdapter {
  switch (config.stack.type) {
    case "node":
      return new NodeAdapter(config, projectRoot);
    case "dotnet":
      return new DotnetAdapter(config, projectRoot);
    case "react-native":
      return new ReactNativeAdapter(config, projectRoot);
    case "custom":
      throw new Error(
        "Custom stack adapter requires a user-provided implementation. See docs/adapters.md for instructions.",
      );
    default:
      throw new Error(`Unsupported stack type: ${config.stack.type}`);
  }
}

function resolveAbsolute(
  configPath: string,
  projectRoot: string,
): string {
  return path.isAbsolute(configPath)
    ? configPath
    : path.join(projectRoot, configPath);
}

async function validateDriftGate(
  slice: Slice,
  config: SliceForgeConfig,
  projectRoot: string,
  testCasesDir: string,
): Promise<void> {
  if (config.loop.testCaseGate === "skip") return;

  const acceptanceTags = slice.acceptance || [];
  let drifted = false;

  for (const tag of acceptanceTags) {
    const docPaths = slice.docs || [];
    if (isDrift(tag, docPaths, projectRoot, testCasesDir)) {
      drifted = true;
      logger.warn(
        `Doc drift or missing test cases detected for tag '${tag}'.`,
      );
    }
  }

  if (drifted && config.loop.testCaseGate === "required") {
    throw new Error(
      `Drift detected for slice ${slice.id}. Run 'sliceforge testgen' to regenerate test cases before building code.`,
    );
  }
}

const REFUSE_MSG =
  "SliceForge requires a clean working tree. Commit or stash your changes, " +
  "or rerun with --git-dirty-mode=stash / --git-dirty-mode=force-reset.";

async function isOwnedDirty(state: RunState, projectRoot: string): Promise<boolean> {
  if (!state.git?.baseSha || !state.git.sliceId) return false;
  if (state.status !== "running") return false;
  if (state.currentSliceId !== state.git.sliceId) return false;
  if (!(await hasUncommittedChanges(projectRoot))) return false;
  return (await getCurrentSha(projectRoot)) === state.git.baseSha;
}

async function ensureCleanForSlice(
  projectRoot: string,
  rollbackMode: GitRollbackMode,
  sliceId: string,
  statePath: string,
  state: RunState,
  preservePaths: string[],
): Promise<void> {
  const owned = await isOwnedDirty(state, projectRoot);

  if (owned) {
    if (rollbackMode !== "none") {
      await resetToSha(projectRoot, state.git!.baseSha!, { preservePaths });
      return;
    }
    throw new Error(
      `Slice ${sliceId} has uncommitted SliceForge-owned changes and rollbackMode=none. ` +
        `Commit, stash, or reset them manually before continuing.`,
    );
  }

  if (await hasUncommittedChanges(projectRoot)) {
    throw new Error(
      "Unexpected dirty working tree detected after preflight cleanup. " +
        "Commit or stash your changes before continuing.",
    );
  }

  state.git = { baseSha: await getCurrentSha(projectRoot), sliceId };
  saveState(statePath, state);
}

function loadGuardrailsContent(guardrailsPath: string): string {
  if (fs.existsSync(guardrailsPath)) {
    return fs.readFileSync(guardrailsPath, "utf8");
  }
  return "";
}

async function runAgentForSlice(
  slice: Slice,
  config: SliceForgeConfig,
  projectRoot: string,
  guardrailsContent: string,
  agentAdapter: AgentAdapter,
): Promise<ReturnType<AgentAdapter["run"]>> {
  const templatePath = resolveTemplatePath(projectRoot, "implementer");
  ensureTemplateExists(
    templatePath,
    "# Implementer Agent\n\nImplement backlog slice: {{SLICE_ID}}\nDescription: {{SLICE_DESCRIPTION}}\nExpect signal: SLICE_DONE\n",
  );

  const prompt = buildPrompt(templatePath, {
    SLICE_ID: slice.id,
    SLICE_DESCRIPTION: slice.description,
    DOCS_LIST: (slice.docs || []).join("\n"),
    ACCEPTANCE_TAGS: (slice.acceptance || []).join(", "),
    PRIOR_FAILURES: guardrailsContent,
    COMPLETION_ARTIFACTS: (slice.completionArtifacts || []).join("\n"),
  });

  logger.info(`Running Implementer Agent for slice ${slice.id}...`);
  return agentAdapter.run(prompt, {
    cwd: projectRoot,
    timeoutMs: config.agent.timeoutMs || 600000,
    model: config.agent.model,
  });
}

async function runGatesPipeline(
  slice: Slice,
  config: SliceForgeConfig,
  projectRoot: string,
  state: RunState,
  guardrailsPath: string,
  stackAdapter: StackAdapter,
  agentAdapter: AgentAdapter,
  retries: number,
): Promise<boolean> {
  state.gatesCompleted = [];

  const checkResult = await runComputationalChecks(
    slice,
    config,
    projectRoot,
    stackAdapter,
  );
  if (!checkResult.pass) {
    const failuresLog = checkResult.failures
      .map((f) => `- [${f.type}] ${f.message}: ${f.details || ""}`)
      .join("\n");
    appendGuardrails(
      guardrailsPath,
      `## [${new Date().toISOString()}] Computational Check Failures (Slice ${slice.id}):\n${failuresLog}\n`,
    );
    state.retriesPerSlice[slice.id] = retries + 1;
    return false;
  }
  state.gatesCompleted.push("checks");

  let browserTestPassed = true;
  if (config.loop.browserTest.required) {
    const requirePreview = config.loop.browserTest.requirePreviewStack;
    try {
      if (requirePreview) {
        await startPreviewStack(config, stackAdapter);
      }

      const browserResult = await runBrowserTestGate(
        slice,
        config,
        projectRoot,
        agentAdapter,
      );
      browserTestPassed = browserResult.pass;

      if (!browserTestPassed) {
        state.retriesPerSlice[slice.id] = retries + 1;
        appendGuardrails(
          guardrailsPath,
          `## [${new Date().toISOString()}] Browser Functional Test Failures (Slice ${slice.id}):\n${browserResult.log}\n`,
        );
      }
    } catch (err) {
      browserTestPassed = false;
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Error during browser testing gate: ${message}`);
      state.retriesPerSlice[slice.id] = retries + 1;
      appendGuardrails(
        guardrailsPath,
        `## [${new Date().toISOString()}] Browser Test Gate Error (Slice ${slice.id}):\n${message}\n`,
      );
    } finally {
      if (requirePreview) {
        await stopPreviewStack(stackAdapter);
      }
    }
  }

  if (!browserTestPassed) return false;
  state.gatesCompleted.push("browser");

  const reviewResult = await runAiReviewGate(
    slice,
    config,
    projectRoot,
    agentAdapter,
    checkResult.pass,
    browserTestPassed,
  );

  if (!reviewResult.pass) {
    state.retriesPerSlice[slice.id] = retries + 1;
    appendGuardrails(
      guardrailsPath,
      `## [${new Date().toISOString()}] AI Review Rejected (Slice ${slice.id}):\n${reviewResult.log}\n`,
    );
    return false;
  }
  state.gatesCompleted.push("review");

  return true;
}

function checkApprovalRequired(
  slice: Slice,
  config: SliceForgeConfig,
  state: RunState,
  statePath: string,
): boolean {
  const requireApprovalList = config.loop.requireHumanApproval || [];
  const hasMatchingTag = (slice.tags || []).some((tag) =>
    requireApprovalList.includes(tag),
  );

  if (hasMatchingTag) {
    logger.section(`HUMAN APPROVAL REQUIRED: Slice ${slice.id}`);
    logger.warn(
      `Slice ${slice.id} passed all validation gates, but matches approval tags. Exiting loop.`,
    );
    logger.warn(
      `Run 'sliceforge approve ${slice.id}' to confirm and commit the slice.`,
    );
    state.status = "pending_approval";
    saveState(statePath, state);
    return true;
  }
  return false;
}

function appendGuardrails(path: string, content: string): void {
  fs.appendFileSync(
    path,
    `\n\n${content}`,
    "utf8",
  );
}

export async function runRalphLoop(
  config: SliceForgeConfig,
  projectRoot: string,
  runOnce: boolean = false,
): Promise<void> {
  const lockPath = resolveAbsolute(config.paths.lock, projectRoot);
  const statePath = resolveAbsolute(config.paths.state, projectRoot);
  const backlogPath = resolveAbsolute(config.paths.backlog, projectRoot);
  const guardrailsPath = resolveAbsolute(
    config.paths.guardrails,
    projectRoot,
  );
  const testCasesDir = resolveAbsolute(
    config.paths.testCases,
    projectRoot,
  );

  logger.section(`Starting SliceForge Ralph Loop for: ${config.project}`);

  acquireLock(lockPath);

  try {
    loadAndValidateSecrets(projectRoot, config.agent.type);

    let state = loadState(statePath);

    if (state.status === "pending_approval") {
      logger.warn(
        `Slice ${state.currentSliceId} is currently pending human approval. Run 'sliceforge approve <sliceId>' to proceed.`,
      );
      return;
    }

    if (state.status === "pending_manual_commit") {
      if (!(await hasUncommittedChanges(projectRoot))) {
        state.status = "running";
        state.git = undefined;
        saveState(statePath, state);
      } else {
        logger.warn(
          "Previous run left an uncommitted slice (autoCommit=false). Commit it, then rerun.",
        );
        return;
      }
    }

    const gitCfg = config.git ?? {};
    const dirtyMode: GitDirtyMode = gitCfg.dirtyMode ?? "refuse";
    const rollbackMode: GitRollbackMode = gitCfg.rollbackMode ?? "slice-only";
    const autoCommit = gitCfg.autoCommit ?? true;

    const preservePaths = [statePath, lockPath, guardrailsPath];

    const dirty = await hasUncommittedChanges(projectRoot);
    const owned = await isOwnedDirty(state, projectRoot);
    if (dirty && !owned) {
      if (dirtyMode === "refuse") throw new Error(REFUSE_MSG);
      if (dirtyMode === "stash")
        await stashChanges(projectRoot, `sliceforge-preflight-${Date.now()}`);
      else if (dirtyMode === "force-reset")
        await resetToLastCommit(projectRoot, preservePaths);
    }

    const backlog = loadBacklog(backlogPath);

    if (allSlicesPass(backlog)) {
      logger.success(
        "All slices in the backlog have passed. Loop complete!",
      );
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
      logger.section(
        `Ralph Loop Iteration ${iteration} (Slice ID: ${slice.id})`,
      );

      state.currentSliceId = slice.id;
      state.status = "running";
      const sliceRetries = state.retriesPerSlice[slice.id] || 0;

      if (sliceRetries >= config.loop.maxRetriesPerSlice) {
        const errorMsg = `Slice ${slice.id} has failed ${sliceRetries} times, which exceeds the max retries limit (${config.loop.maxRetriesPerSlice}). Escalating and aborting loop.`;
        logger.error(errorMsg);
        state.status = "running";
        saveState(statePath, state);
        throw new Error(errorMsg);
      }

      await validateDriftGate(slice, config, projectRoot, testCasesDir);

      await ensureCleanForSlice(
        projectRoot,
        rollbackMode,
        slice.id,
        statePath,
        state,
        preservePaths,
      );

      const guardrailsContent = loadGuardrailsContent(guardrailsPath);

      const agentResult = await runAgentForSlice(
        slice,
        config,
        projectRoot,
        guardrailsContent,
        agentAdapter,
      );

      if (agentResult.usage) {
        state.costAccumulated.inputTokens += agentResult.usage.inputTokens;
        state.costAccumulated.outputTokens +=
          agentResult.usage.outputTokens;
        state.costAccumulated.estimatedCostUSD =
          (state.costAccumulated.estimatedCostUSD || 0) +
          (agentResult.usage.estimatedCostUSD || 0);
        logger.info(
          `Accumulated Token usage: Input=${state.costAccumulated.inputTokens}, Output=${state.costAccumulated.outputTokens} ($${state.costAccumulated.estimatedCostUSD.toFixed(3)})`,
        );
      }

      if (agentResult.signal !== AgentSignal.SLICE_DONE) {
        logger.error(
          `Implementer Agent failed with signal: ${agentResult.signal}. Retrying.`,
        );
        state.retriesPerSlice[slice.id] = sliceRetries + 1;
        appendGuardrails(
          guardrailsPath,
          `## [${new Date().toISOString()}] Slice ${slice.id} Implementation Error:\n${agentResult.output}\n`,
        );
        saveState(statePath, state);
        if (runOnce) break;
        continue;
      }

      logger.info("Implementation done. Starting gates verification...");

      const gatesPassed = await runGatesPipeline(
        slice,
        config,
        projectRoot,
        state,
        guardrailsPath,
        stackAdapter,
        agentAdapter,
        sliceRetries,
      );

      if (!gatesPassed) {
        saveState(statePath, state);
        if (runOnce) break;
        continue;
      }

      if (checkApprovalRequired(slice, config, state, statePath)) {
        break;
      }

      logger.success(
        `Slice ${slice.id} successfully implemented! Committing to git...`,
      );

      const originalBacklog = fs.readFileSync(backlogPath, "utf8");
      try {
        markSliceDone(backlog, slice.id);
        saveBacklog(backlogPath, backlog);
        if (autoCommit) {
          await commitSlice(
            projectRoot,
            slice.id,
            `aih/slice-${slice.id} completed successfully`,
          );
        } else {
          logger.warn(
            "autoCommit disabled; backlog marked done — commit the code AND backlog.json together, then rerun.",
          );
          state.status = "pending_manual_commit";
        }
        state.git = undefined;
        state.retriesPerSlice[slice.id] = 0;
        saveState(statePath, state);
        if (!autoCommit && !runOnce) break;
      } catch (err) {
        const resetResult = await spawnCommand("git", ["reset", "--mixed", "HEAD"], {
          cwd: projectRoot,
        });
        if (resetResult.exitCode !== 0) {
          logger.warn(`Failed to unstage changes during rollback: ${resetResult.stderr}`);
        }
        fs.writeFileSync(backlogPath, originalBacklog, "utf8");
        throw err;
      }

      if (runOnce) break;
    }
  } finally {
    releaseLock(lockPath);
  }
}

export async function approveSlice(
  config: SliceForgeConfig,
  projectRoot: string,
  sliceId: string,
): Promise<void> {
  const statePath = resolveAbsolute(config.paths.state, projectRoot);
  const backlogPath = resolveAbsolute(config.paths.backlog, projectRoot);

  const state = loadState(statePath);

  if (
    state.status !== "pending_approval" ||
    state.currentSliceId !== sliceId
  ) {
    throw new Error(
      `Slice ${sliceId} is not currently pending human approval.`,
    );
  }

  logger.info(`Approving slice ${sliceId}...`);

  const gitCfg = config.git ?? {};
  const autoCommit = gitCfg.autoCommit ?? true;
  const backlog = loadBacklog(backlogPath);

  const originalBacklog = fs.readFileSync(backlogPath, "utf8");
  try {
    markSliceDone(backlog, sliceId);
    saveBacklog(backlogPath, backlog);
    if (autoCommit) {
      await commitSlice(
        projectRoot,
        sliceId,
        `aih/slice-${sliceId} approved and completed`,
      );
      state.status = "running";
    } else {
      logger.warn(
        "autoCommit disabled; backlog marked done — commit the code AND backlog.json together, then rerun.",
      );
      state.status = "pending_manual_commit";
    }
    state.git = undefined;
    state.retriesPerSlice[sliceId] = 0;
    saveState(statePath, state);
  } catch (err) {
    const resetResult = await spawnCommand("git", ["reset", "--mixed", "HEAD"], { cwd: projectRoot });
    if (resetResult.exitCode !== 0) {
      logger.warn(`Failed to unstage changes during rollback: ${resetResult.stderr}`);
    }
    fs.writeFileSync(backlogPath, originalBacklog, "utf8");
    throw err;
  }

  logger.success(`Slice ${sliceId} approved and committed.`);
}
