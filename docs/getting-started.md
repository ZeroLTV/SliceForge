# Getting Started with SliceForge

SliceForge is a reliable local-first AI Harness Engine for evidence-driven software delivery.

## Prerequisites

- Node.js 20 or newer
- Git and a repository with an initial commit
- One configured workspace agent: `codex`, `claude`, `cursor-agent`, or a generic JSON-protocol command
- Stack tools used by your gates, such as npm, dotnet, uv, Poetry, Maven, or Gradle

Docker and Playwright are optional. They are required only when your explicit commands or browser gate use them.

## Install and Initialize

```bash
npm install -g @zeroltv/sliceforge
cd /path/to/project
sliceforge init
```

`init` creates `sliceforge.config.jsonc` and `sliceforge.plan.yaml`. Review and commit them once. Initialization does not modify source code.

Use non-interactive initialization in automation:

```bash
sliceforge init --agent codex --yes
```

Choose one model for all generated agent roles when the selected CLI supports model selection:

```bash
sliceforge init --agent cursor --model auto --yes
```

The model is written to `sliceforge.config.jsonc`; omitting `--model` keeps the agent CLI default.

## Validate the Environment

```bash
sliceforge doctor
sliceforge plan validate
```

`doctor` checks Git cleanliness, Node, agent executables, target roots, command executables, shell use, browser configuration, likely embedded secrets and write permissions. Fix every `FAIL`; review every `WARN`.

## Create a Task Without Writing YAML

```bash
sliceforge do "Add a user management screen with loading, empty and error states"
```

The engine stores task state below the Git common directory, inventories local targets and documentation, calculates a readiness score and either produces an immutable plan or stops with at most three questions.

The generated config assigns the selected agent to `clarifier` and `planner`. These stages run through strict JSON request/response schemas in disposable read-only worktrees. The deterministic readiness and plan builders remain safety proposals; agent output cannot remove deterministic blockers or bypass target, path, dependency, evidence and gate validation.

The default minimum readiness score is 70. A long request is not considered clear merely because it contains many words; missing scope, expected behavior or verification creates a blocking `readiness-gap` question.

Answer every blocking question and approve the exact plan fingerprint:

```bash
sliceforge task answer <task-id> --set expected-outcome="Users can create, disable and search accounts"
sliceforge task answer <task-id> --set interaction-contract="Desktop and mobile; loading, empty, error and success"
sliceforge task approve <task-id>
sliceforge queue start
```

If the plan or resulting UI is not acceptable, create a new immutable revision instead of editing runtime state:

```bash
sliceforge task revise <task-id> --feedback="Use a compact table and keep filters visible on mobile"
sliceforge task approve <task-id>
```

Use `--image`, `--from` or `--figma` with `do` for optional local references. Figma content is resolved only through an explicitly configured provider command; SliceForge has no built-in network client.

For UI tasks, an optional Playwright visual gate can require fixed desktop/mobile screenshots, no runtime errors, no overflow, no accessibility violations, no missing assets and a pixel threshold against reviewed PNG baselines. The browser and its binaries must pass `doctor`; subjective appearance still requires human approval.

## Run and Promote Verified Work

```bash
sliceforge run first-slice
sliceforge status
sliceforge inspect <run-id>
sliceforge promote <run-id>
```

`run` is the low-level path for a manually authored YAML slice. The task queue uses the same isolated orchestrator and deterministic gates. For a graph with several slices, the queue integrates verified slices into a task staging worktree in dependency order, validates the complete bundle, and exposes one final run ID for manual promotion.

Public CLI, package export, schema, controller, route and API-contract changes trigger a post-change documentation check. Broken changed Markdown fails policy; a public-surface change with no documentation update stops at `needs_attention` instead of silently claiming docs are current. Use task revision feedback to request the missing docs, or accept the checkpoint only after confirming no documentation change is needed.

Before `promote`, all edits and commits exist only on SliceForge branches and temporary worktrees. A low-level slice uses `sliceforge/<slice-id>/<run-id>`; a queued task additionally uses a task staging branch and produces one immutable bundle run. If the original HEAD advances, promotion is blocked:

```bash
sliceforge rebase <run-id>
sliceforge promote <run-id>
```

Rebase reruns deterministic gates, path policy, read-only review and the final fingerprint.

## Recovery and Cancellation

```bash
sliceforge resume <run-id>
sliceforge cancel <run-id>
sliceforge clean
```

`resume` reconciles the atomic state file with the event journal, restores or recreates the worktree, and rolls back incomplete Git operations when possible. A blocked run must be inspected and normally rebased rather than blindly resumed.

## Test Generation and CI

```bash
sliceforge testgen first-slice
sliceforge verify --ci
```

TestGen may write only `docs/test-cases/**`. Its YAML output must satisfy the bundled schema and cover every acceptance ID. `verify --ci` runs deterministic gates on current code and never invokes a write-capable agent or promotes a commit.

HTML reports are self-contained files and need no local server. Runtime state and default reports are stored under the Git common directory.

## Continuous Queue and Evaluation

```bash
sliceforge queue start --concurrency 2
sliceforge queue start --watch --poll-ms 5000
sliceforge queue pause
sliceforge queue resume
sliceforge eval run evaluations/model-regression.json
```

Queue workers use leases and heartbeats. Expired leases are recovered after a crash. The queue never promotes automatically and stops at ambiguity, attention, policy, gate or budget boundaries.

Release qualification can exercise the real Git/task/bundle queue continuously. The short form is suitable for a local smoke run; use 24 hours before a stable release:

```bash
npm run build
npm run soak:queue -w packages/engine -- --duration-ms 30000
npm run soak:queue -w packages/engine -- --duration-hours 24
```

The harness fails on duplicate or missing task processing, non-promotable bundles, queue failures, or any mutation of the original worktree. The scheduled nightly workflow runs the short form; `workflow_dispatch` accepts `soak_hours: 24` for release evidence.

Tasks sharing a target are serialized. Network-capable tasks on different targets may run concurrently with distinct machine-wide TTL port leases exposed as `PORT` and `SLICEFORGE_PORT`. Multi-slice graphs run through task staging and are revalidated as one immutable bundle before manual promotion.

Evaluation suites are JSON command protocols. Each case is repeated for configured context variants; the command returns raw acceptance, claim, changed-file, gate, duration and cost evidence, and SliceForge derives the metrics. A baseline cannot be accepted when a trial, schema, policy, evidence, consistency, flaky-gate or secret check fails.

Use a baseline only for the same suite, harness policy and context fingerprint. SliceForge reports agent/model/CLI version drift without failing solely because a version string changed, but the new version must still satisfy every deterministic metric. Context or harness configuration drift blocks the comparison because the two runs are no longer equivalent.
