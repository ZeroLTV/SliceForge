# SliceForge

[![CI Status](https://github.com/ZeroLTV/SliceForge/actions/workflows/ci.yml/badge.svg)](https://github.com/ZeroLTV/SliceForge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

SliceForge is a reliable local-first AI Harness Engine. Each implementation runs on a dedicated Git branch and worktree; the original project is unchanged until you explicitly promote a verified commit.

## Guarantees

- AI output alone never passes a slice. Configured commands, artifacts and path policies provide the evidence.
- `unverified` acceptance evidence can never be promoted. Only `manual_required` evidence or advisory review findings can be accepted explicitly.
- Implementers write only in an isolated worktree. Reviewers are read-only and checked with before/after fingerprints.
- Dependency preparation and deterministic gates run against the candidate commit in a disposable detached worktree.
- State, locks and an append-only event journal live under the Git common directory, not in the working tree.
- Network-capable runs receive a short-lived machine-wide port lease; the same port is injected into agents and deterministic commands as `PORT` and `SLICEFORGE_PORT`.
- Optional visual gates validate real PNG dimensions, desktop/mobile findings and pixel differences against tracked baselines; AI visual opinions remain advisory.
- `promote` requires a clean original tree at the recorded base SHA. HEAD drift requires `rebase` and fresh gates.
- No SliceForge telemetry, hosted account or dashboard. Data leaves the machine only through an agent you configure.

## Requirements

- Node.js 20 or newer
- Git with an initial commit
- Codex, Claude Code, Cursor Agent, or a command implementing the JSON agent protocol

## Quick Start

```bash
npm install -g @zeroltv/sliceforge
cd your-project
sliceforge init
sliceforge doctor
sliceforge do "Add user management with loading, empty and error states"
# If blocked: sliceforge task answer <task-id>
sliceforge task approve <task-id>
sliceforge queue start
sliceforge task list
sliceforge promote <run-id>
```

`do` gathers local project context, scores task readiness and asks at most three blocking questions. It creates an immutable, human-approved slice graph before any write-capable agent runs. The generated project files remain `sliceforge.config.jsonc` and `sliceforge.plan.yaml`; the latter is also the low-level audit and manual-planning format.

When `agents.clarifier` and `agents.planner` are configured, `do` invokes them through strict role-specific JSON contracts inside disposable read-only worktrees. Their output is only a proposal: SliceForge independently enforces target scope, dependency cycles, path ownership, acceptance evidence and executable gates. Omitting either optional role uses the deterministic fallback for that stage.

The task queue executes dependency-ordered slice graphs in a task staging worktree. Each verified slice is integrated into staging, then the complete graph is revalidated as one immutable bundle. The original branch receives only that bundle commit after an explicit `promote`.

Node, .NET, Python, Java, React Native and common Node monorepos are detected. Ambiguous or unavailable capabilities are reported by `doctor` rather than silently treated as passing.

## Commands

Golden path: `do`, `task list|inspect|answer|approve|revise|cancel`, and `queue start|pause|resume|status`. Use `queue start --watch` for a long-running worker; it still never promotes automatically.

Evaluation: `eval run|compare|accept-baseline`.

Low-level control: `init`, `doctor`, `plan validate`, `run`, `resume`, `testgen`, `status`, `inspect`, `report`, `promote`, `rebase`, `cancel`, `clean`, and `verify --ci`.

Exit codes are stable: `0` pass, `1` gate failure, `2` configuration/environment error, `3` blocked/approval required, and `4` internal/recovery error.

See [Getting Started](docs/getting-started.md), [Configuration](docs/configuration.md), and [Architecture](docs/architecture.md).

The repository includes a CI-validated [minimal Node example](examples/minimal-node) with a complete config and plan.

## License

MIT. See [LICENSE](LICENSE).
