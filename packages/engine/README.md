# @zeroltv/sliceforge

[![npm version](https://img.shields.io/npm/v/@zeroltv/sliceforge.svg)](https://www.npmjs.com/package/@zeroltv/sliceforge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

**SliceForge** is a reliable local-first AI Harness Engine for evidence-driven software delivery. It runs deterministic gates before creating a verified commit and never changes the original project until an explicit `sliceforge promote <run-id>`.

- AI output alone never passes a slice. Configured commands, artifacts and path policies provide the evidence.
- `unverified` acceptance evidence can never be promoted. Only `manual_required` evidence or advisory review findings can be accepted explicitly.
- Each implementation runs on a dedicated Git branch and worktree; the original project is unchanged until you explicitly promote a verified commit.
- State, locks and an append-only event journal live under the Git common directory, not in the working tree.

## Install

```bash
npm install -g @zeroltv/sliceforge
```

Requirements: Node.js 20+, Git with an initial commit, and one configured agent (Codex, Claude Code, Cursor Agent, or a command implementing the JSON agent protocol).

## Quick Start

```bash
sliceforge init
sliceforge doctor
sliceforge do "Add a testable user workflow"
sliceforge task approve <task-id>
sliceforge queue start
sliceforge promote <run-id>
```

`do` gathers local project context, scores task readiness and asks at most three blocking questions. It creates an immutable, human-approved slice graph before any write-capable agent runs.

## How it works

- **Local-first isolation.** Implementers write only in an isolated worktree. Reviewers are read-only and checked with before/after fingerprints.
- **Deterministic gates.** Dependency preparation and deterministic gates run against the candidate commit in a disposable detached worktree.
- **Evidence over opinion.** Only configured commands, artifacts and path policies establish trust. AI visual opinions remain advisory.
- **Port leases.** Network-capable runs receive a short-lived machine-wide port lease; the same port is injected into agents and deterministic commands as `PORT` and `SLICEFORGE_PORT`.
- **Visual gates (optional).** Validate real PNG dimensions, desktop/mobile findings and pixel differences against tracked baselines using Playwright.
- **Safe promotion.** `promote` requires a clean original tree at the recorded base SHA. HEAD drift requires `rebase` and fresh gates.
- **No telemetry.** No hosted account, dashboard or telemetry. Data leaves the machine only through an agent you configure.

## Commands

Golden path:

```bash
sliceforge do "Add user management with loading, empty and error states"
sliceforge task list|inspect|answer|approve|revise|cancel
sliceforge queue start|pause|resume|status
sliceforge promote <run-id>
```

Evaluation:

```bash
sliceforge eval run|compare|accept-baseline
```

Low-level control:

```bash
sliceforge init
sliceforge doctor
sliceforge plan validate
sliceforge run|resume|testgen|status|inspect|report
sliceforge promote|rebase|cancel|clean
sliceforge verify --ci
```

Exit codes are stable: `0` pass, `1` gate failure, `2` configuration/environment error, `3` blocked/approval required, `4` internal/recovery error.

## Task Queue

The task queue executes dependency-ordered slice graphs in a task staging worktree. Each verified slice is integrated into staging, then the complete graph is revalidated as one immutable bundle. The original branch receives only that bundle commit after an explicit `promote`.

```bash
sliceforge queue start --concurrency 2
sliceforge queue start --watch --poll-ms 5000
sliceforge queue pause
sliceforge queue resume
```

Queue workers use leases and heartbeats. Expired leases are recovered after a crash. The queue never promotes automatically and stops at ambiguity, attention, policy, gate or budget boundaries.

## Optional Agents

When `agents.clarifier` and `agents.planner` are configured, `do` invokes them through strict role-specific JSON contracts inside disposable read-only worktrees. Their output is only a proposal: SliceForge independently enforces target scope, dependency cycles, path ownership, acceptance evidence and executable gates. Omitting either optional role uses the deterministic fallback for that stage.

Supported agents: `codex`, `claude`, `cursor`, or any command implementing the published JSON agent request/response schemas.

## Configuration

`init` creates `sliceforge.config.jsonc` and `sliceforge.plan.yaml`. Node, .NET, Python, Java, React Native and common Node monorepos are detected. Ambiguous or unavailable capabilities are reported by `doctor` rather than silently treated as passing.

## Documentation

- [Getting Started](https://github.com/ZeroLTV/SliceForge/blob/main/docs/getting-started.md)
- [Configuration](https://github.com/ZeroLTV/SliceForge/blob/main/docs/configuration.md)
- [Architecture](https://github.com/ZeroLTV/SliceForge/blob/main/docs/architecture.md)

The repository includes a CI-validated [minimal Node example](https://github.com/ZeroLTV/SliceForge/tree/main/examples/minimal-node) with a complete config and plan.

## Development

```bash
npm install
npm run build -w packages/engine
npm run lint -w packages/engine
npm run test -w packages/engine
```

## License

MIT. See [LICENSE](./LICENSE).
