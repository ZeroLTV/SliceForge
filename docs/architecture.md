# SliceForge Architecture

SliceForge is a reliable local-first AI Harness Engine. Its runtime coordinates agents, deterministic gates, Git isolation and explicit promotion into one recoverable workflow.

## Runtime Flow

The task-level golden path wraps the existing slice runtime without weakening its trust boundary:

```text
raw request + optional local inputs
     |
     v
context fingerprint -> readiness/clarification
     |
     v
validated Slice Graph -> human approval
     |
     v
persistent queue lease -> isolated slice runtime
     |
     v
acceptance evidence -> human promote
```

```text
plan validate
     |
     v
create branch + isolated worktree
     |
     v
implementer -> changed-path policy
     |
     v
commit isolated candidate
     |
     v
detached validation worktree -> dependency preparation
     |
     v
artifact -> build -> lint -> unit -> integration -> e2e/browser
     |
     v
read-only reviewer -> final path policy + fingerprint
     |
     v
immutable candidate -> ready_to_promote
     |
     v
manual promote -> base/clean/fingerprint checks -> cherry-pick
```

The original worktree is read-only to the run until the final cherry-pick. Gates never run in the original or candidate worktree: they run against the candidate commit in a disposable detached worktree. A failed cherry-pick or rebase is aborted before the operation returns.

## State and Recovery

States are `planned`, `preparing`, `implementing`, `validating`, `reviewing`, `needs_attention`, `ready_to_promote`, `promoting`, `promoted`, `failed`, `blocked`, and `cancelled`.

Each transition appends and fsyncs a JSONL event before atomically replacing `state.json`. If a crash lands between those writes, load reconciles state to the latest journal sequence. Missing worktrees and branches are recreated from the recorded base SHA. An interrupted promotion compares Git trees to distinguish a completed cherry-pick from an operation that must remain blocked.

Runtime layout:

```text
<git-common-dir>/sliceforge/
  runs/<run-id>/state.json
  runs/<run-id>/events.jsonl
  tasks/<task-id>/state.json
  tasks/<task-id>/events.jsonl
  tasks/<task-id>/attachments/*
  evaluations/<evaluation-id>.json
  evaluations/baselines/<name>.json
  reports/<run-id>.html
<os-temp>/sliceforge-worktrees/<repo-key>/<run-id>/
```

## Trust Boundaries

- Agent response JSON is strict: duplicate keys, partial/multiple documents, unknown fields, bad diagnostics and nonzero exits are rejected.
- Changed files are computed from Git porcelain/diff data; agent-declared artifact and command lists are informational.
- Command execution is shell-free unless explicitly enabled, bounded, timed out, environment-limited and redacted.
- Artifacts and command working directories cannot traverse or resolve through symlinks outside the worktree.
- Reviewer fingerprints cover both the candidate and original worktrees. Reviewer writes or Git HEAD changes invalidate the run.
- Preparation and gate commands run in a detached validation worktree. Any mutation other than the declared browser report invalidates the result.
- Clarifier and planner agents run in disposable detached worktrees. Their before/after Git fingerprints must match, and their responses pass the published role-specific JSON Schema plus engine-owned graph/evidence validation.
- Browser visual evidence uses a published manifest schema. Screenshot files must be safe PNG artifacts with exact viewport dimensions; runtime, overflow, accessibility and asset findings are policy checked, while pixel differences are computed by the engine from decoded PNGs and tracked baselines.
- Reports contain sanitized diffs and logs. SliceForge itself has no network or telemetry client.

## Adapters and Monorepos

Built-in agents are Codex, Claude Code and Cursor Agent. The generic stdin/stdout JSON protocol is the extension point.

Clarifier output contains readiness, no more than three decision-blocking questions and assumptions. Planner output contains slices, dependencies, evidence, risks and optional estimated cost. A configured planning role fails closed on invalid output; deterministic fallback is used only when that optional role is absent from config. Planner output cannot widen the task's selected targets or establish a pass without executable evidence.

Task intake builds a bounded repository context pack from selected target roots. It includes prioritized conventions, manifests, relevant API/schema sources and documentation with per-file fingerprints and short snippets. Collection skips symlinks, protected paths, binary files, generated/vendor directories and files over 128 KiB; the packet is capped at 40 files and 64 KiB of snippets. Only the explicitly configured clarifier/planner command receives this local context.

Project detection supports npm/pnpm/yarn workspaces, Nx, Turbo, .NET solutions/projects, Python pip/Poetry/uv, Maven, Gradle and React Native scripts. Workspace package dependencies become target dependencies and are executed in topological order for affected targets.

CI executes generated prepare/build/lint/test commands for Node, React Native, Python, .NET, Maven multi-module, Gradle multi-module and Nx/Turbo workspace fixtures on Windows, macOS and Linux. Detection-only unit fixtures additionally cover npm, pnpm, Yarn Classic and Yarn Berry lockfile behavior.

Playwright is an optional capability. The configured browser command owns navigation and capture, but it cannot declare visual success: SliceForge parses the Playwright JSON report and visual manifest, constrains generated files to the configured artifact directory, decodes screenshots, computes pixel diffs and maps the browser gate to acceptance evidence.

## CI

`verify --ci` is intentionally report-only. It requires a clean tree and runs deterministic gates in a disposable detached worktree at current `HEAD`; it cannot invoke implementers, create a promotion commit or mutate the original branch.

## Queue and Evaluation

Queue items are immutable approved graph fingerprints. Workers claim them with a renewable lease; expired leases transition through `blocked` back to `queued`. Independent task runs may execute concurrently in separate worktrees, but promotion remains serialized and manual.

Workers acquire target locks, so tasks sharing a target remain serialized. Integration, E2E and browser runs on independent targets may execute concurrently. A machine-wide allocator under OS application data assigns each active run a TTL-backed port lease, checks that the port is not already bound by another process, injects it into agents and commands, renews it while work is active, and releases it after execution. Expired leases are removed on the next allocation after a crash.

Every generated graph is also persisted as `plan-revision-<n>.yaml` in the task runtime directory. Feedback creates a new fingerprinted revision and invalidates prior task-level evidence; it never edits an approved snapshot in place.

Runs from an older revision are recorded as superseded. `resume` and `promote` reject them even if their previous deterministic gates passed.

Each approved task revision owns a staging branch and worktree. Dependency-ordered slices are verified in isolated child runs and integrated into staging one at a time. After all slices are integrated, SliceForge creates a bundle commit whose parent is the task's recorded base SHA and reruns every slice's path policy, artifacts, deterministic gates, review and acceptance mapping against that immutable bundle. Only the bundle run can be promoted to the original branch.

The task record persists the pending slice run, integrated slice IDs and bundle run ID before crossing each recovery boundary. On restart, a promoted pending slice is marked integrated without rerunning it, and an already registered bundle is rediscovered by task ID, base SHA and exact slice set. Original HEAD drift still blocks promotion; rebasing a bundle reruns validation for every included slice.

Deterministic failures create normalized fingerprints. Automatic repair stops at the configured attempt count or when the same failure fingerprint repeats. Reviewer findings and manual evidence never trigger blind repair.

Evaluation commands are generic local protocols. SliceForge controls repetition and context variants, calculates consistency/evidence/policy metrics, stores local baselines and blocks seeded safety, schema, acceptance, success-rate, flaky-gate, behavior-variance or changed-file-variance regressions.

Evaluation commands return raw acceptance evidence, claims, changed files, gates and output. SliceForge derives schema compliance, path-policy violations, unsupported claims, fingerprints and secret leakage instead of trusting precomputed metric flags.

Baseline comparison is provenance-bound. Suite identity, harness configuration and context fingerprints must remain equal. Agent/model/CLI version changes are preserved as drift metadata and are allowed only when the resulting run still satisfies all deterministic thresholds.
