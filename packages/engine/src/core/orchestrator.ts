import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type {
  GateResult,
  RunRecord,
  SliceDefinition,
  SliceForgeConfig,
  SliceForgePlan,
  EvidenceStatus,
  ExecutionAgentRole,
  FailurePacket,
} from "./contracts.js";
import { validatePlan, validateProject } from "./config-loader.js";
import { GitService } from "./git-service.js";
import { createRunId, getRuntimePaths, RuntimeStore } from "./runtime-store.js";
import { AgentProtocolRunner, createAgentRequest } from "./agent-protocol.js";
import { validateChangedPaths, validateDocumentation } from "./policy.js";
import {
  DeterministicGateRunner,
  deterministicGatesPassed,
  prepareSliceTargets,
} from "./gate-runner.js";
import { HtmlReporter } from "./reporter.js";
import { validateGeneratedTestCases } from "./testcase-validator.js";
import { redactDiff } from "./redaction.js";
import { getPortAllocatorDataRoot, PortAllocator } from "./port-allocator.js";
import { routeAgent, sliceComplexity } from "./agent-router.js";

export interface RunOutcome {
  run: RunRecord;
  reportPath: string;
}

export interface BundleCandidate {
  taskId: string;
  baseBranch: string;
  baseSha: string;
  commitSha: string;
  slices: SliceDefinition[];
}

interface Context {
  config: SliceForgeConfig;
  plan: SliceForgePlan;
  git: GitService;
  store: RuntimeStore;
  reporter: HtmlReporter;
  ports: PortAllocator;
  portOwnerPrefix: string;
}

class DeterministicGateError extends Error {}

function needsRuntimePort(config: SliceForgeConfig, slices: SliceDefinition[]): boolean {
  return slices.some((slice) => {
    const enabled = new Set(slice.requiredGates ?? config.gates.order);
    return enabled.has("integration") || enabled.has("e2e") || enabled.has("browser");
  });
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-|-$/g, "");
}

function failedGate(gates: GateResult[]): GateResult | undefined {
  return gates.find((gate) => gate.status === "failed");
}

function documentationPolicy(
  config: SliceForgeConfig,
  worktreePath: string,
  slices: SliceDefinition[],
  changedFiles: string[],
): { warnings: string[]; artifacts: string[] } {
  const documentation = changedFiles.filter((file) => /(^docs\/|\.(md|mdx)$)/i.test(file));
  const existingDocumentation = documentation.filter((file) =>
    fs.existsSync(path.join(worktreePath, file)),
  );
  const violations = validateDocumentation(worktreePath, existingDocumentation);
  if (violations.length) {
    throw new Error(`Documentation policy failed: ${violations.join("; ")}`);
  }
  if (!(config.documentation?.requireReviewWhenUncertain ?? true)) {
    return { warnings: [], artifacts: existingDocumentation };
  }
  const publicChanges = changedFiles.filter((file) =>
    /(^|\/)(src\/cli|cli|schemas?|controllers?|routes?|openapi|swagger|graphql|proto|public)(\/|\.|$)|(^|\/)package\.json$|(^|\/)src\/index\.[cm]?[jt]s$/i.test(
      file,
    ),
  );
  if (!publicChanges.length || existingDocumentation.length) {
    return { warnings: [], artifacts: existingDocumentation };
  }
  return {
    warnings: slices.map(
      (slice) =>
        `Public surface changed without documentation: ${publicChanges.join(", ")} (slice ${slice.id}, docsImpact=${slice.docsImpact ?? "review"}).`,
    ),
    artifacts: existingDocumentation,
  };
}

function recordDocumentationAttention(
  run: RunRecord,
  slices: SliceDefinition[],
  result: { warnings: string[]; artifacts: string[] },
): boolean {
  if (!result.warnings.length) return false;
  const startedAt = new Date().toISOString();
  for (const [index, warning] of result.warnings.entries()) {
    run.gates.push({
      id: `${slices[index]?.id ?? run.sliceId}:docs-impact`,
      kind: "artifact",
      status: "warning",
      startedAt,
      durationMs: 0,
      summary: warning,
      artifacts: result.artifacts,
    });
  }
  return true;
}

function failurePacket(message: string, attempt: number): FailurePacket {
  const normalized = message.replace(/\d+/g, "#").replace(/\s+/g, " ").trim().toLowerCase();
  const category: FailurePacket["category"] = /policy|path|mutation|protected/.test(message)
    ? "policy"
    : /gate|build|lint|test|artifact|browser/.test(message)
      ? "gate"
      : /agent|protocol|reviewer/.test(message)
        ? "agent"
        : /git|command|executable|environment/.test(message)
          ? "environment"
          : "internal";
  return {
    fingerprint: crypto.createHash("sha256").update(normalized).digest("hex"),
    category,
    owner: category === "agent" ? "implementer" : "engine",
    summary: message,
    gateIds: [],
    attempt,
    occurredAt: new Date().toISOString(),
  };
}

function acceptanceCoverage(
  slice: SliceDefinition,
  gates: GateResult[],
): RunRecord["acceptanceCoverage"] {
  return slice.acceptance.map((criterion) => {
    const requirements = (slice.evidence ?? []).filter(
      (item) => item.acceptanceId === criterion.id && item.required !== false,
    );
    const passed = gates.filter((gate) => gate.status === "passed");
    const matches = (requirement: NonNullable<SliceDefinition["evidence"]>[number]) =>
      passed.filter((gate) => {
        if (requirement.kind === "manual") return false;
        const sourceMatches = requirement.source
          ? requirement.source === gate.id ||
            requirement.source === gate.kind ||
            gate.artifacts.includes(requirement.source)
          : true;
        if (!sourceMatches) return false;
        if (requirement.kind === "artifact") return gate.kind === "artifact";
        if (requirement.kind === "visual") return gate.kind === "browser";
        if (requirement.kind === "test")
          return ["unit", "integration", "e2e", "browser"].includes(gate.kind);
        return !["artifact", "review"].includes(gate.kind);
      });
    const nonManual = requirements.filter((item) => item.kind !== "manual");
    const manual = requirements.some((item) => item.kind === "manual");
    const evidence = requirements.length
      ? [...new Set(nonManual.flatMap((item) => matches(item).map((gate) => gate.id)))]
      : passed.filter((gate) => gate.kind !== "review").map((gate) => gate.id);
    const deterministicSatisfied = requirements.length
      ? nonManual.every((item) => matches(item).length > 0)
      : evidence.length > 0;
    const status: EvidenceStatus = !deterministicSatisfied
      ? "unverified"
      : manual
        ? "manual_required"
        : "verified";
    return { id: criterion.id, status, evidence };
  });
}

export class SliceForgeOrchestrator {
  private readonly agents = new AgentProtocolRunner();
  private readonly gates = new DeterministicGateRunner();

  private async withPortLease<T>(
    context: Context,
    owner: string,
    slices: SliceDefinition[],
    run: RunRecord | undefined,
    action: (environment: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    if (!needsRuntimePort(context.config, slices)) return action({});
    const leaseMs = context.config.execution?.leaseMs ?? 60_000;
    const leaseOwner = `${context.portOwnerPrefix}:${owner}`;
    const lease = await context.ports.acquire(leaseOwner, leaseMs);
    const names = context.config.execution?.portEnv ?? ["PORT", "SLICEFORGE_PORT"];
    const environment = Object.fromEntries(names.map((name) => [name, String(lease.port)]));
    if (run) {
      run.runtimeEnv = environment;
      context.store.saveRun(run);
    }
    let leaseLost = false;
    let renewal = Promise.resolve();
    const heartbeat = setInterval(
      () => {
        renewal = renewal.then(async () => {
          try {
            leaseLost ||= !(await context.ports.renew(leaseOwner, leaseMs));
          } catch {
            leaseLost = true;
          }
        });
      },
      Math.max(1000, Math.floor(leaseMs / 3)),
    );
    heartbeat.unref();
    try {
      const result = await action(environment);
      if (leaseLost) throw new Error(`Runtime port lease was lost for ${owner}.`);
      return result;
    } finally {
      clearInterval(heartbeat);
      await renewal;
      await context.ports.release(leaseOwner);
    }
  }

  private async review(
    context: Context,
    run: RunRecord,
    slice: SliceDefinition,
    diff: string,
  ): Promise<boolean> {
    const enabled =
      context.config.gates.review.enabled &&
      (slice.requiredGates
        ? slice.requiredGates.includes("review")
        : context.config.gates.order.includes("review"));
    if (!enabled) return false;

    context.store.transition(run, "reviewing", "Running read-only AI review.");
    const reviewRoot = path.join(context.store.runDirectory(run.runId), "reviewer");
    fs.rmSync(reviewRoot, { recursive: true, force: true });
    fs.mkdirSync(reviewRoot, { recursive: true });
    const originalHeadBefore = await context.git.head();
    const originalFingerprintBefore = await context.git.fingerprint(run.baseSha, run.projectRoot);
    const candidateFingerprintBefore = await context.git.fingerprint(run.baseSha, run.worktreePath);
    const startedAt = Date.now();
    const review = await this.agents.run(
      routeAgent(context.config, "reviewer", {
        targets: slice.targets,
        complexity: sliceComplexity(slice),
      })!,
      createAgentRequest(run.runId, "reviewer", reviewRoot, slice, {
        readOnly: true,
        allowedPaths: [],
        artifacts: [],
        priorFailures: run.priorFailures,
        diff,
        environment: run.runtimeEnv,
      }),
      context.config.reporting.maxLogBytes,
      context.store.cancellationFile(run.runId),
    );
    run.agentResponses.reviewer = review;
    const reviewerWrites = fs.readdirSync(reviewRoot);
    const originalHeadAfter = await context.git.head();
    const originalFingerprintAfter = await context.git.fingerprint(run.baseSha, run.projectRoot);
    const candidateFingerprintAfter = await context.git.fingerprint(run.baseSha, run.worktreePath);
    const reviewerViolations = [
      ...reviewerWrites.map((file) => `reviewer wrote ${file}`),
      ...(candidateFingerprintAfter !== candidateFingerprintBefore
        ? ["reviewer mutated the candidate worktree"]
        : []),
      ...(originalHeadAfter !== originalHeadBefore ||
      originalFingerprintAfter !== originalFingerprintBefore
        ? ["reviewer mutated the original worktree or Git HEAD"]
        : []),
    ];
    if (reviewerViolations.length > 0) {
      run.policyViolations = [...(run.policyViolations ?? []), ...reviewerViolations];
      context.store.saveRun(run);
      throw new Error(
        `Reviewer mutated state or violated read-only policy: ${reviewerViolations.join(", ")}.`,
      );
    }
    const needsAttention =
      review.status !== "completed" || review.diagnostics.some((item) => item.severity === "error");
    run.gates.push({
      id: `${slice.id}:review`,
      kind: "review",
      status: needsAttention
        ? context.config.gates.review.advisory
          ? "warning"
          : "failed"
        : "passed",
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      summary: review.summary,
      artifacts: [],
    });
    context.store.saveRun(run);
    if (needsAttention && !context.config.gates.review.advisory) {
      throw new Error(`Blocking AI review finding: ${review.summary}`);
    }
    return needsAttention;
  }

  private async validateCandidate(
    context: Context,
    run: RunRecord,
    slice: SliceDefinition,
    candidateSha: string,
    sanitizedDiff: string,
  ): Promise<boolean> {
    const validationPath = `${run.worktreePath}-validation`;
    try {
      await context.git.removeWorktree(validationPath, true);
    } catch {
      // Stale metadata is pruned by create/restore operations below.
    }
    if (fs.existsSync(validationPath)) {
      throw new Error(`Stale validation path requires cleanup: ${validationPath}`);
    }
    await context.git.createDetachedWorktree(validationPath, candidateSha);
    try {
      context.store.transition(run, "validating", "Preparing detached validation worktree.");
      await prepareSliceTargets(
        context.config,
        slice,
        validationPath,
        context.store.cancellationFile(run.runId),
        run.runtimeEnv,
      );
      const afterPreparation = await context.git.status(validationPath);
      if (afterPreparation.length > 0) {
        throw new Error(
          `Preparation mutated candidate files: ${afterPreparation.map((item) => item.path).join(", ")}`,
        );
      }
      const gateResults = await this.gates.run(
        context.config,
        slice,
        validationPath,
        context.store.cancellationFile(run.runId),
        run.runtimeEnv,
      );
      run.gates.push(...gateResults);
      context.store.saveRun(run);
      if (!deterministicGatesPassed(gateResults)) {
        throw new DeterministicGateError(
          failedGate(gateResults)?.summary ?? "No deterministic gate produced passing evidence.",
        );
      }
      const allowedGenerated = new Set(gateResults.flatMap((gate) => gate.artifacts));
      const gateMutations = (await context.git.status(validationPath)).filter(
        (item) => !allowedGenerated.has(item.path.replace(/\\/g, "/")),
      );
      if (gateMutations.length > 0) {
        throw new Error(
          `A validation command mutated candidate files: ${gateMutations.map((item) => item.path).join(", ")}`,
        );
      }
      return await this.review(context, run, slice, sanitizedDiff);
    } finally {
      try {
        await context.git.removeWorktree(validationPath, true);
      } catch {
        // The run remains recoverable; clean can prune stale validation resources.
      }
    }
  }

  private async context(projectRoot: string): Promise<Context> {
    const root = path.resolve(projectRoot);
    const { config, plan } = validateProject(root);
    const git = new GitService(root);
    await git.assertRepository();
    const runtimePaths = getRuntimePaths(root, await git.commonDir());
    if (config.reporting.directory)
      runtimePaths.reports = path.resolve(runtimePaths.root, config.reporting.directory);
    const store = new RuntimeStore(runtimePaths);
    const portRange = config.execution?.portRange ?? { start: 41_000, end: 41_999 };
    return {
      config,
      plan,
      git,
      store,
      reporter: new HtmlReporter(store),
      ports: new PortAllocator(getPortAllocatorDataRoot(), portRange.start, portRange.end),
      portOwnerPrefix: crypto.createHash("sha256").update(root).digest("hex").slice(0, 16),
    };
  }

  private async selectSlice(
    plan: SliceForgePlan,
    store: RuntimeStore,
    git: GitService,
    requested?: string,
  ): Promise<SliceDefinition> {
    const promoted = new Set<string>();
    for (const run of store
      .listRuns()
      .filter((item) => item.kind === "implementation" && item.status === "promoted")) {
      if (run.promotedSha && (await git.isAncestor(run.promotedSha))) {
        promoted.add(run.sliceId);
      }
    }
    if (requested) {
      const slice = plan.slices.find((candidate) => candidate.id === requested);
      if (!slice) throw new Error(`Slice not found: ${requested}`);
      const missing = (slice.dependsOn ?? []).filter((dependency) => !promoted.has(dependency));
      if (missing.length > 0) {
        throw new Error(
          `Slice '${slice.id}' is blocked by unpromoted dependencies: ${missing.join(", ")}.`,
        );
      }
      return slice;
    }
    const ready = plan.slices
      .filter((slice) => !promoted.has(slice.id))
      .filter((slice) => (slice.dependsOn ?? []).every((dependency) => promoted.has(dependency)))
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
    if (!ready[0]) throw new Error("No runnable slice remains; dependencies may be incomplete.");
    return ready[0];
  }

  private testGenSlice(source: SliceDefinition): SliceDefinition {
    const artifact = `docs/test-cases/${source.id}.yaml`;
    return {
      ...source,
      title: `Generate acceptance test cases for ${source.title}`,
      allowedPaths: ["docs/test-cases/**"],
      requiredArtifacts: [artifact],
      requiredGates: ["artifact"],
      evidence: source.acceptance.map((criterion) => ({
        acceptanceId: criterion.id,
        kind: "artifact" as const,
        source: artifact,
        required: true,
      })),
    };
  }

  async start(projectRoot: string, requestedSlice?: string): Promise<RunOutcome> {
    const context = await this.context(projectRoot);
    return context.store.withProjectLock(async () => {
      if (!(await context.git.isClean())) {
        throw new Error(
          "Original working tree must be clean. Commit or stash changes before running SliceForge.",
        );
      }
      const slice = await this.selectSlice(
        context.plan,
        context.store,
        context.git,
        requestedSlice,
      );
      const runId = createRunId(slice.id);
      const baseSha = await context.git.head();
      const baseBranch = await context.git.branch();
      const branchName = `sliceforge/${slug(slice.id)}/${runId}`;
      const worktreePath = path.join(context.store.paths.worktrees, runId);
      const now = new Date().toISOString();
      const run: RunRecord = {
        schemaVersion: 1,
        runId,
        kind: "implementation",
        projectRoot: path.resolve(projectRoot),
        sliceId: slice.id,
        status: "planned",
        baseBranch,
        baseSha,
        branchName,
        worktreePath,
        attempt: 0,
        createdAt: now,
        updatedAt: now,
        sequence: 0,
        priorFailures: [],
        gates: [],
        agentResponses: {},
      };
      context.store.saveRun(run);
      context.store.transition(run, "preparing", "Creating isolated worktree.");
      try {
        await context.git.createWorktree(worktreePath, branchName, baseSha);
      } catch (err) {
        context.store.transition(run, "failed", "Failed to create isolated worktree.", {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
      return this.execute(context, run, slice, "implementer");
    });
  }

  async startDefinition(projectRoot: string, slice: SliceDefinition): Promise<RunOutcome> {
    const context = await this.context(projectRoot);
    validatePlan({ schemaVersion: 1, slices: [slice] }, context.config, path.resolve(projectRoot));
    const run = await context.store.withProjectLock(async () => {
      if (!(await context.git.isClean())) {
        throw new Error(
          "Original working tree must be clean. Commit or stash changes before running SliceForge.",
        );
      }
      const runId = createRunId(slice.id);
      const baseSha = await context.git.head();
      const baseBranch = await context.git.branch();
      const branchName = `sliceforge/${slug(slice.id)}/${runId}`;
      const worktreePath = path.join(context.store.paths.worktrees, runId);
      const now = new Date().toISOString();
      const run: RunRecord = {
        schemaVersion: 1,
        runId,
        kind: "implementation",
        projectRoot: path.resolve(projectRoot),
        sliceId: slice.id,
        status: "planned",
        baseBranch,
        baseSha,
        branchName,
        worktreePath,
        attempt: 0,
        createdAt: now,
        updatedAt: now,
        sequence: 0,
        priorFailures: [],
        failureHistory: [],
        gates: [],
        agentResponses: {},
      };
      context.store.saveRun(run);
      context.store.transition(
        run,
        "preparing",
        "Creating isolated worktree for task graph slice.",
      );
      await context.git.createWorktree(worktreePath, branchName, baseSha);
      return run;
    });
    return this.execute(context, run, slice, "implementer");
  }

  async registerBundle(projectRoot: string, bundle: BundleCandidate): Promise<RunOutcome> {
    const context = await this.context(projectRoot);
    validatePlan(
      { schemaVersion: 1, slices: bundle.slices },
      context.config,
      path.resolve(projectRoot),
    );
    const run = await context.store.withProjectLock(async () => {
      const runId = createRunId(`task-${bundle.taskId}`);
      const branchName = `sliceforge/task-${slug(bundle.taskId)}/${runId}`;
      const worktreePath = path.join(context.store.paths.worktrees, runId);
      const now = new Date().toISOString();
      const record: RunRecord = {
        schemaVersion: 1,
        runId,
        kind: "task",
        projectRoot: path.resolve(projectRoot),
        sliceId: `task:${bundle.taskId}`,
        status: "planned",
        baseBranch: bundle.baseBranch,
        baseSha: bundle.baseSha,
        branchName,
        worktreePath,
        attempt: 1,
        createdAt: now,
        updatedAt: now,
        sequence: 0,
        priorFailures: [],
        failureHistory: [],
        gates: [],
        agentResponses: {},
        commitSha: bundle.commitSha,
        bundleSlices: bundle.slices,
      };
      context.store.saveRun(record);
      context.store.transition(record, "preparing", "Creating immutable task bundle worktree.");
      await context.git.createWorktree(worktreePath, branchName, bundle.commitSha);
      return record;
    });
    return this.withPortLease(context, run.runId, bundle.slices, run, async () => {
      try {
        const changed = await context.git.changedSince(run.baseSha, run.worktreePath);
        const allowedPaths = [...new Set(bundle.slices.flatMap((slice) => slice.allowedPaths))];
        const violations = validateChangedPaths(
          changed,
          allowedPaths,
          context.config.policies.protectedPatterns,
        );
        if (violations.length)
          throw new Error(`Task bundle path policy failed: ${violations.join("; ")}`);
        const artifacts = [
          ...new Set(bundle.slices.flatMap((slice) => slice.requiredArtifacts ?? [])),
        ];
        await context.git.assertArtifactsTracked(run.worktreePath, artifacts);
        run.changedFiles = changed;
        const docsResult = documentationPolicy(
          context.config,
          run.worktreePath,
          bundle.slices,
          changed,
        );
        run.sanitizedDiff = redactDiff(
          await context.git.diff(run.baseSha, run.worktreePath),
          context.config.policies.protectedPatterns,
        );
        let needsAttention = false;
        const coverage: NonNullable<RunRecord["acceptanceCoverage"]> = [];
        for (const slice of bundle.slices) {
          const gateStart = run.gates.length;
          needsAttention =
            (await this.validateCandidate(
              context,
              run,
              slice,
              bundle.commitSha,
              run.sanitizedDiff,
            )) || needsAttention;
          coverage.push(...(acceptanceCoverage(slice, run.gates.slice(gateStart)) ?? []));
        }
        run.acceptanceCoverage = coverage;
        needsAttention ||= coverage.some((item) => item.status !== "verified");
        needsAttention ||= recordDocumentationAttention(run, bundle.slices, docsResult);
        run.finalFingerprint = await context.git.fingerprint(run.baseSha, run.worktreePath);
        context.store.transition(
          run,
          needsAttention ? "needs_attention" : "ready_to_promote",
          needsAttention
            ? "Integrated task bundle passed deterministic gates but needs explicit attention."
            : "Integrated task bundle is verified and ready for manual promotion.",
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        run.priorFailures.push(`Bundle validation: ${message}`);
        context.store.transition(run, "failed", message);
      }
      return { run, reportPath: context.reporter.writeRun(run) };
    });
  }

  async startTestGen(projectRoot: string, requestedSlice?: string): Promise<RunOutcome> {
    const context = await this.context(projectRoot);
    return context.store.withProjectLock(async () => {
      if (!(await context.git.isClean())) {
        throw new Error("Original working tree must be clean before TestGen.");
      }
      const sourceSlice = await this.selectSlice(
        context.plan,
        context.store,
        context.git,
        requestedSlice,
      );
      const slice = this.testGenSlice(sourceSlice);
      const runId = createRunId(`testgen-${slice.id}`);
      const baseSha = await context.git.head();
      const baseBranch = await context.git.branch();
      const branchName = `sliceforge/testgen-${slug(slice.id)}/${runId}`;
      const worktreePath = path.join(context.store.paths.worktrees, runId);
      const now = new Date().toISOString();
      const run: RunRecord = {
        schemaVersion: 1,
        runId,
        kind: "testgen",
        projectRoot: path.resolve(projectRoot),
        sliceId: slice.id,
        status: "planned",
        baseBranch,
        baseSha,
        branchName,
        worktreePath,
        attempt: 0,
        createdAt: now,
        updatedAt: now,
        sequence: 0,
        priorFailures: [],
        gates: [],
        agentResponses: {},
      };
      context.store.saveRun(run);
      context.store.transition(run, "preparing", "Creating isolated TestGen worktree.");
      await context.git.createWorktree(worktreePath, branchName, baseSha);
      return this.execute(context, run, slice, "testgen");
    });
  }

  async resume(projectRoot: string, runId: string): Promise<RunOutcome> {
    const context = await this.context(projectRoot);
    return context.store.withProjectLock(async () => {
      const run = context.store.loadRun(runId);
      if (context.store.isRunSuperseded(runId)) {
        throw new Error(
          `Run ${runId} was superseded by a newer task revision and cannot be resumed.`,
        );
      }
      if (run.status === "promoting") {
        await context.git.abortCherryPick();
        const currentHead = await context.git.head();
        const completed =
          Boolean(run.commitSha) &&
          (await context.git.isClean()) &&
          (await context.git.branch()) === run.baseBranch &&
          (await context.git.firstParent()) === run.baseSha &&
          (await context.git.tree()) === (await context.git.tree(run.commitSha));
        if (completed) {
          run.promotedSha = currentHead;
          context.store.transition(
            run,
            "promoted",
            "Recovered promotion after an interrupted state write.",
            { promotedSha: run.promotedSha },
          );
          try {
            await context.git.removeWorktree(run.worktreePath);
            await context.git.deleteBranch(run.branchName);
          } catch {
            context.store.transition(
              run,
              "promoted",
              "Recovered promotion; automatic worktree cleanup needs attention.",
            );
          }
        } else {
          context.store.transition(
            run,
            "blocked",
            "Interrupted promotion was rolled back; inspect and promote again.",
          );
        }
        return { run, reportPath: context.reporter.writeRun(run) };
      }
      if (["ready_to_promote", "needs_attention", "promoted"].includes(run.status)) {
        return { run, reportPath: context.reporter.writeRun(run) };
      }
      if (run.kind === "task") {
        throw new Error(
          `Task bundle ${runId} cannot rerun an implementer. Requeue the task or use rebase when a verified commit exists.`,
        );
      }
      const sourceSlice = context.plan.slices.find((candidate) => candidate.id === run.sliceId);
      if (!sourceSlice) throw new Error(`Slice '${run.sliceId}' no longer exists in the plan.`);
      const slice = run.kind === "testgen" ? this.testGenSlice(sourceSlice) : sourceSlice;
      if (run.status === "cancelled") throw new Error(`Run ${runId} was cancelled.`);
      if (run.status === "blocked")
        throw new Error(`Run ${runId} is blocked. Inspect it and use rebase or cancel.`);
      if (run.status === "failed") run.attempt = 0;
      await context.git.restoreWorktree(run.worktreePath, run.branchName, run.baseSha);
      await context.git.resetWorktree(run.worktreePath, run.baseSha);
      context.store.transition(run, "preparing", "Recovered run and reset isolated worktree.");
      return this.execute(context, run, slice, run.kind === "testgen" ? "testgen" : "implementer");
    });
  }

  private async execute(
    context: Context,
    run: RunRecord,
    slice: SliceDefinition,
    role: ExecutionAgentRole,
  ): Promise<RunOutcome> {
    return this.withPortLease(context, run.runId, [slice], run, (environment) =>
      this.executeWithEnvironment(context, run, slice, role, environment),
    );
  }

  private async executeWithEnvironment(
    context: Context,
    run: RunRecord,
    slice: SliceDefinition,
    role: ExecutionAgentRole,
    environment: Record<string, string>,
  ): Promise<RunOutcome> {
    const maxAttempts = slice.retryPolicy?.maxAttempts ?? context.config.policies.maxRetries + 1;
    while (run.attempt < maxAttempts) {
      run.attempt += 1;
      context.store.transition(
        run,
        "implementing",
        `${role} attempt ${run.attempt}/${maxAttempts}.`,
      );
      try {
        const response = await this.agents.run(
          routeAgent(context.config, role, {
            targets: slice.targets,
            complexity: sliceComplexity(slice),
          })!,
          createAgentRequest(run.runId, role, run.worktreePath, slice, {
            readOnly: false,
            allowedPaths: slice.allowedPaths,
            artifacts: slice.requiredArtifacts ?? [],
            priorFailures: run.priorFailures,
            environment,
          }),
          context.config.reporting.maxLogBytes,
          context.store.cancellationFile(run.runId),
        );
        run.agentResponses[role] = response;
        context.store.saveRun(run);
        if (response.status !== "completed")
          throw new Error(`${role} returned ${response.status}: ${response.summary}`);

        if (role === "testgen") {
          validateGeneratedTestCases(
            path.join(run.worktreePath, slice.requiredArtifacts![0]),
            slice,
          );
        }

        const changed = await context.git.changedSince(run.baseSha, run.worktreePath);
        const pathViolations = validateChangedPaths(
          changed,
          slice.allowedPaths,
          context.config.policies.protectedPatterns,
        );
        if (pathViolations.length)
          throw new Error(`Changed-path policy failed: ${pathViolations.join("; ")}`);
        if (changed.length === 0)
          throw new Error("Agent completed without producing any project change.");
        run.changedFiles = changed;
        const docsResult = documentationPolicy(context.config, run.worktreePath, [slice], changed);
        run.sanitizedDiff = redactDiff(
          await context.git.diff(run.baseSha, run.worktreePath),
          context.config.policies.protectedPatterns,
        );
        const candidateSha = await context.git.commit(
          run.worktreePath,
          `sliceforge(${slice.id}): ${slice.title}`,
        );
        await context.git.assertArtifactsTracked(run.worktreePath, slice.requiredArtifacts ?? []);
        run.finalFingerprint = await context.git.fingerprint(run.baseSha, run.worktreePath);
        const reviewNeedsAttention = await this.validateCandidate(
          context,
          run,
          slice,
          candidateSha,
          run.sanitizedDiff,
        );
        const docsNeedAttention = recordDocumentationAttention(run, [slice], docsResult);
        context.store.saveRun(run);
        const coverage = acceptanceCoverage(slice, run.gates) ?? [];
        run.acceptanceCoverage = coverage;
        const evidenceNeedsAttention = coverage.some((item) => item.status !== "verified");
        if ((await context.git.head(run.worktreePath)) !== candidateSha) {
          throw new Error("Candidate branch changed during detached validation.");
        }
        run.commitSha = candidateSha;
        context.store.transition(
          run,
          reviewNeedsAttention || evidenceNeedsAttention || docsNeedAttention
            ? "needs_attention"
            : "ready_to_promote",
          reviewNeedsAttention || evidenceNeedsAttention || docsNeedAttention
            ? "Deterministic gates passed; review or acceptance evidence needs explicit attention."
            : "Verified commit is ready for manual promotion.",
        );
        return { run, reportPath: context.reporter.writeRun(run) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        run.priorFailures.push(`Attempt ${run.attempt}: ${message}`);
        const failure = failurePacket(message, run.attempt);
        run.failureHistory = [...(run.failureHistory ?? []), failure];
        try {
          run.changedFiles = await context.git.changedSince(run.baseSha, run.worktreePath);
          run.sanitizedDiff = redactDiff(
            await context.git.diff(run.baseSha, run.worktreePath),
            context.config.policies.protectedPatterns,
          );
        } catch {
          // Preserve the primary failure if Git inspection is unavailable during recovery.
        }
        context.store.saveRun(run);
        if (context.store.isCancellationRequested(run.runId)) {
          context.store.transition(run, "cancelled", "Run cancelled and active process stopped.");
          try {
            await context.git.removeWorktree(run.worktreePath, true);
            await context.git.deleteBranch(run.branchName);
          } catch {
            // clean can retry stale resource cleanup.
          }
          return { run, reportPath: context.reporter.writeRun(run) };
        }
        const repeated = run.failureHistory.filter(
          (item) => item.fingerprint === failure.fingerprint,
        ).length;
        const repeatedLimit = context.config.execution?.maxRepeatedFailure ?? 2;
        if (
          !(err instanceof DeterministicGateError) ||
          run.attempt >= maxAttempts ||
          repeated >= repeatedLimit
        ) {
          context.store.transition(run, "failed", message);
          return { run, reportPath: context.reporter.writeRun(run) };
        }
        await context.git.resetWorktree(run.worktreePath, run.baseSha);
        context.store.transition(run, "preparing", `Retrying after failure: ${message}`);
      }
    }
    throw new Error("Unreachable retry state.");
  }

  async promote(projectRoot: string, runId: string, acceptAttention = false): Promise<RunOutcome> {
    const context = await this.context(projectRoot);
    return context.store.withProjectLock(async () => {
      const run = context.store.loadRun(runId);
      if (context.store.isRunSuperseded(runId)) {
        throw new Error(
          `Run ${runId} was superseded by a newer task revision and cannot be promoted.`,
        );
      }
      if (!run.acceptanceCoverage?.length) {
        throw new Error(`Run ${runId} has no recorded acceptance evidence and cannot be promoted.`);
      }
      const unverified = (run.acceptanceCoverage ?? []).filter(
        (item) => item.status === "unverified",
      );
      if (unverified.length) {
        throw new Error(
          `Run ${runId} has unverified acceptance evidence (${unverified.map((item) => item.id).join(", ")}) and cannot be promoted.`,
        );
      }
      if (run.status === "needs_attention" && !acceptAttention) {
        throw new Error(
          `Run ${runId} requires explicit human acceptance. Inspect it, then use --accept-attention.`,
        );
      }
      if (!["ready_to_promote", "needs_attention"].includes(run.status)) {
        throw new Error(`Run ${runId} is not promotable (status: ${run.status}).`);
      }
      if (!(await context.git.isClean()))
        throw new Error("Original working tree must be clean before promote.");
      const currentBranch = await context.git.branch();
      if (currentBranch !== run.baseBranch) {
        context.store.transition(
          run,
          "blocked",
          "Original branch changed; checkout the recorded base branch before promotion.",
          {
            expected: run.baseBranch,
            actual: currentBranch,
          },
        );
        throw new Error(
          `Original branch changed. Checkout '${run.baseBranch}', then retry promote.`,
        );
      }
      const currentHead = await context.git.head();
      if (currentHead !== run.baseSha) {
        context.store.transition(
          run,
          "blocked",
          "Original HEAD changed; rebase and rerun gates before promote.",
          {
            expected: run.baseSha,
            actual: currentHead,
          },
        );
        throw new Error(`Original HEAD changed. Run 'sliceforge rebase ${runId}'.`);
      }
      if (!run.commitSha || (await context.git.head(run.worktreePath)) !== run.commitSha) {
        throw new Error("Verified worktree commit does not match recorded state.");
      }
      const fingerprint = await context.git.fingerprint(run.baseSha, run.worktreePath);
      if (fingerprint !== run.finalFingerprint)
        throw new Error("Worktree changed after validation; rerun the slice.");
      context.store.transition(
        run,
        "promoting",
        "Cherry-picking verified commit into the original branch.",
      );
      try {
        await context.git.cherryPick(run.commitSha);
        const clean = await context.git.isClean();
        const promotedTree = await context.git.tree();
        const verifiedTree = await context.git.tree(run.commitSha, run.worktreePath);
        if (!clean || promotedTree !== verifiedTree) {
          await context.git.rollbackOriginal(run.baseSha);
          throw new Error(
            "Post-promotion Git state differed from the verified commit; original branch was rolled back.",
          );
        }
      } catch (err) {
        const recovered =
          (await context.git.isClean()) && (await context.git.head()) === run.baseSha;
        context.store.transition(
          run,
          recovered ? "failed" : "blocked",
          recovered
            ? "Promotion failed and original tree was rolled back."
            : "Promotion recovery could not prove the original tree was restored; manual Git inspection is required.",
          {
            error: err instanceof Error ? err.message : String(err),
          },
        );
        throw err;
      }
      run.promotedSha = await context.git.head();
      context.store.transition(run, "promoted", "Verified slice promoted successfully.", {
        promotedSha: run.promotedSha,
      });
      try {
        await context.git.removeWorktree(run.worktreePath);
        await context.git.deleteBranch(run.branchName);
      } catch (err) {
        context.store.transition(
          run,
          "promoted",
          "Promotion succeeded; automatic worktree cleanup needs attention.",
          {
            cleanupError: err instanceof Error ? err.message : String(err),
          },
        );
      }
      return { run, reportPath: context.reporter.writeRun(run) };
    });
  }

  async rebase(projectRoot: string, runId: string): Promise<RunOutcome> {
    const context = await this.context(projectRoot);
    return context.store.withProjectLock(async () => {
      const run = context.store.loadRun(runId);
      if (
        !run.commitSha ||
        !["ready_to_promote", "needs_attention", "blocked"].includes(run.status)
      ) {
        throw new Error(`Run ${runId} has no verified commit to rebase.`);
      }
      if (!(await context.git.isClean()))
        throw new Error("Original working tree must be clean before rebase.");
      const currentBranch = await context.git.branch();
      if (currentBranch !== run.baseBranch) {
        context.store.transition(
          run,
          "blocked",
          "Checkout the recorded base branch before rebasing the run.",
          {
            expected: run.baseBranch,
            actual: currentBranch,
          },
        );
        throw new Error(
          `Original branch changed. Checkout '${run.baseBranch}', then retry rebase.`,
        );
      }
      await context.git.restoreWorktree(run.worktreePath, run.branchName, run.baseSha);
      const newBase = await context.git.head();
      try {
        await context.git.rebase(run.worktreePath, newBase);
      } catch (err) {
        context.store.transition(
          run,
          "blocked",
          "Rebase conflict requires manual resolution in the isolated worktree.",
        );
        throw err;
      }
      run.baseSha = newBase;
      const candidateSha = await context.git.head(run.worktreePath);
      run.commitSha = candidateSha;
      const sourceSlice = context.plan.slices.find((candidate) => candidate.id === run.sliceId);
      const slices = run.bundleSlices?.length
        ? run.bundleSlices
        : sourceSlice
          ? [run.kind === "testgen" ? this.testGenSlice(sourceSlice) : sourceSlice]
          : [];
      if (!slices.length) throw new Error(`Run ${runId} has no recoverable slice specification.`);
      return this.withPortLease(context, runId, slices, run, async () => {
        const changed = await context.git.changedSince(run.baseSha, run.worktreePath);
        const violations = validateChangedPaths(
          changed,
          [...new Set(slices.flatMap((slice) => slice.allowedPaths))],
          context.config.policies.protectedPatterns,
        );
        if (violations.length) {
          context.store.transition(
            run,
            "failed",
            `Post-rebase path policy failed: ${violations.join("; ")}`,
          );
        } else {
          await context.git.assertArtifactsTracked(run.worktreePath, [
            ...new Set(slices.flatMap((slice) => slice.requiredArtifacts ?? [])),
          ]);
          run.finalFingerprint = await context.git.fingerprint(run.baseSha, run.worktreePath);
          run.changedFiles = changed;
          run.sanitizedDiff = redactDiff(
            await context.git.diff(run.baseSha, run.worktreePath),
            context.config.policies.protectedPatterns,
          );
          try {
            const docsResult = documentationPolicy(
              context.config,
              run.worktreePath,
              slices,
              changed,
            );
            let reviewNeedsAttention = false;
            const coverage: NonNullable<RunRecord["acceptanceCoverage"]> = [];
            for (const slice of slices) {
              const gateStart = run.gates.length;
              reviewNeedsAttention =
                (await this.validateCandidate(
                  context,
                  run,
                  slice,
                  candidateSha,
                  run.sanitizedDiff,
                )) || reviewNeedsAttention;
              coverage.push(...(acceptanceCoverage(slice, run.gates.slice(gateStart)) ?? []));
            }
            run.acceptanceCoverage = coverage;
            const evidenceNeedsAttention = coverage.some((item) => item.status !== "verified");
            const docsNeedAttention = recordDocumentationAttention(run, slices, docsResult);
            context.store.transition(
              run,
              reviewNeedsAttention || evidenceNeedsAttention || docsNeedAttention
                ? "needs_attention"
                : "ready_to_promote",
              reviewNeedsAttention || evidenceNeedsAttention || docsNeedAttention
                ? "Rebase gates passed; review or acceptance evidence needs explicit attention."
                : "Rebase and all configured gates completed; ready to promote.",
            );
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            run.priorFailures.push(`Post-rebase validation: ${message}`);
            context.store.transition(run, "failed", message);
          }
        }
        return { run, reportPath: context.reporter.writeRun(run) };
      });
    });
  }

  async cancel(projectRoot: string, runId: string): Promise<RunOutcome> {
    const context = await this.context(projectRoot);
    const current = context.store.loadRun(runId);
    if (current.status === "promoted") throw new Error("A promoted run cannot be cancelled.");
    context.store.requestCancellation(runId);
    return context.store.withProjectLock(
      async () => {
        const run = context.store.loadRun(runId);
        if (run.status === "promoted") throw new Error("A promoted run cannot be cancelled.");
        if (run.status !== "cancelled") {
          context.store.transition(run, "cancelled", "Run cancelled by user.");
        }
        try {
          await context.git.removeWorktree(run.worktreePath, true);
          await context.git.deleteBranch(run.branchName);
        } catch {
          // State remains cancelled; clean can retry stale resource cleanup.
        }
        return { run, reportPath: context.reporter.writeRun(run) };
      },
      { retries: 120, minTimeoutMs: 250, maxTimeoutMs: 250 },
    );
  }

  async inspect(projectRoot: string, runId: string): Promise<RunOutcome> {
    const context = await this.context(projectRoot);
    const run = context.store.loadRun(runId);
    return { run, reportPath: context.reporter.writeRun(run) };
  }

  async list(projectRoot: string): Promise<RunRecord[]> {
    return (await this.context(projectRoot)).store.listRuns();
  }

  async reportPath(projectRoot: string, runId: string): Promise<string> {
    return (await this.inspect(projectRoot, runId)).reportPath;
  }

  async verify(
    projectRoot: string,
    requestedSlice?: string,
  ): Promise<{ passed: boolean; gates: GateResult[]; reportPath: string }> {
    const context = await this.context(projectRoot);
    if (!(await context.git.isClean())) {
      throw new Error(
        "verify --ci requires a clean working tree so it can validate an immutable HEAD.",
      );
    }
    const slices = requestedSlice
      ? [
          context.plan.slices.find((slice) => slice.id === requestedSlice) ??
            (() => {
              throw new Error(`Slice not found: ${requestedSlice}`);
            })(),
        ]
      : [...context.plan.slices].sort(
          (a, b) => a.priority - b.priority || a.id.localeCompare(b.id),
        );
    const verificationId = `verify-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    return this.withPortLease(context, verificationId, slices, undefined, async (environment) => {
      const gates: GateResult[] = [];
      const validationPath = path.join(context.store.paths.worktrees, verificationId);
      await context.git.createDetachedWorktree(validationPath, await context.git.head());
      try {
        for (const slice of slices) {
          await prepareSliceTargets(context.config, slice, validationPath, undefined, environment);
          const preparationMutations = await context.git.status(validationPath);
          if (preparationMutations.length > 0) {
            throw new Error(
              `Preparation mutated immutable CI input: ${preparationMutations.map((item) => item.path).join(", ")}`,
            );
          }
          const results = await this.gates.run(
            context.config,
            slice,
            validationPath,
            undefined,
            environment,
          );
          gates.push(...results);
          const allowedGenerated = new Set(results.flatMap((gate) => gate.artifacts));
          const mutations = (await context.git.status(validationPath)).filter(
            (item) => !allowedGenerated.has(item.path.replace(/\\/g, "/")),
          );
          if (mutations.length > 0) {
            gates.push({
              id: `${slice.id}:ci-mutation`,
              kind: "artifact",
              status: "failed",
              startedAt: new Date().toISOString(),
              durationMs: 0,
              summary: `CI gate mutated immutable input: ${mutations.map((item) => item.path).join(", ")}`,
              artifacts: [],
            });
            break;
          }
          if (!deterministicGatesPassed(results)) break;
        }
      } finally {
        await context.git.removeWorktree(validationPath, true);
      }
      const passed = deterministicGatesPassed(gates);
      return {
        passed,
        gates,
        reportPath: context.reporter.writeVerification(path.resolve(projectRoot), gates, passed),
      };
    });
  }

  async clean(projectRoot: string): Promise<{ removed: string[] }> {
    const context = await this.context(projectRoot);
    return context.store.withProjectLock(async () => {
      const removed: string[] = [];
      const terminal = new Set(["promoted", "cancelled", "failed"]);
      const runs = context.store.listRuns().slice(context.config.reporting.retainRuns);
      for (const run of runs) {
        if (!terminal.has(run.status)) continue;
        try {
          await context.git.removeWorktree(run.worktreePath, true);
          await context.git.deleteBranch(run.branchName);
        } catch {
          // The resources may already be gone.
        }
        fs.rmSync(context.store.runDirectory(run.runId), { recursive: true, force: true });
        const report = path.join(context.store.paths.reports, `${run.runId}.html`);
        if (fs.existsSync(report)) fs.unlinkSync(report);
        removed.push(run.runId);
      }
      return { removed };
    });
  }
}
