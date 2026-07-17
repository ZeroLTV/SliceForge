# @zeroltv/sliceforge

SliceForge is a reliable local-first AI Harness Engine for evidence-driven software delivery. It runs deterministic gates before creating a verified commit and never changes the original project until an explicit `sliceforge promote <run-id>`.

```bash
npm install -g @zeroltv/sliceforge
sliceforge init
sliceforge doctor
sliceforge do "Add a testable user workflow"
sliceforge task approve <task-id>
sliceforge queue start
sliceforge promote <run-id>
```

Dependency-ordered multi-slice tasks are integrated in a dedicated staging worktree and revalidated as one immutable bundle. `unverified` acceptance evidence cannot be promoted, and original source remains unchanged until the final explicit promote.

Configured clarifier and planner agents use strict published JSON schemas in disposable read-only worktrees. Their graph proposals must pass engine-owned target, path, dependency, evidence and gate validation before human approval.

Integration, E2E and browser runs use machine-wide TTL port leases injected as `PORT` and `SLICEFORGE_PORT`, allowing independent targets to run concurrently without holding a global network lock.

Optional Playwright visual evidence uses a published manifest, safe fixed-size PNG artifacts, structured runtime/overflow/accessibility/asset findings and engine-computed pixel diffs against tracked baselines.

Full documentation and architecture are available in the [SliceForge repository](https://github.com/ZeroLTV/SliceForge).
