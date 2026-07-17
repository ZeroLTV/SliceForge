# SliceForge Configuration

SliceForge is a reliable local-first AI Harness Engine. This file defines the targets, commands, agents and evidence gates used by the runtime.

SliceForge uses `sliceforge.config.jsonc` with mandatory `schemaVersion: 1`. The generated `$schema` property enables editor completion against the bundled JSON Schema.

## CommandSpec

Commands are structured and run without a shell by default:

```jsonc
{
  "command": "npm",
  "args": ["run", "test:unit"],
  "cwd": ".",
  "timeoutMs": 600000,
  "envAllowlist": ["CI"],
}
```

`cwd` cannot escape its target, including through a symlink. Child processes receive only essential OS execution variables, explicitly allowlisted variables, and fixed `env` values. Do not store credentials in `env`; use `envAllowlist`. `shell: true` is explicit, discouraged for portability and injection safety, and reported by `doctor`.

## Complete Example

```jsonc
{
  "$schema": "https://unpkg.com/@zeroltv/sliceforge@1.0.0/dist/schemas/config.schema.json",
  "schemaVersion": 1,
  "project": "my-app",
  "agents": {
    "clarifier": { "type": "codex" },
    "planner": { "type": "codex" },
    "implementer": { "type": "codex" },
    "testgen": { "type": "codex" },
    "reviewer": { "type": "claude" },
  },
  "targets": {
    "api": {
      "root": "services/api",
      "preset": "node",
      "prepare": { "command": "npm", "args": ["ci"], "timeoutMs": 600000 },
      "commands": {
        "build": { "command": "npm", "args": ["run", "build"] },
        "lint": { "command": "npm", "args": ["run", "lint"] },
        "unit": { "command": "npm", "args": ["run", "test:unit"] },
      },
    },
    "web": {
      "root": "apps/web",
      "preset": "node",
      "dependsOn": ["api"],
      "commands": {
        "build": { "command": "npm", "args": ["run", "build"] },
        "unit": { "command": "npm", "args": ["run", "test"] },
      },
    },
  },
  "isolation": { "mode": "worktree" },
  "gates": {
    "order": ["artifact", "build", "lint", "unit", "integration", "e2e", "browser", "review"],
    "browser": { "enabled": false },
    "review": { "enabled": true, "advisory": true },
  },
  "policies": {
    "protectedPatterns": [
      "**/.env*",
      "**/*.pem",
      ".git/**",
      "sliceforge.config.jsonc",
      "sliceforge.plan.yaml",
    ],
    "maxRetries": 2,
  },
  "routing": {
    "fallbackRole": "implementer",
    "maxEstimatedCostUSD": 5,
    "minimumReadinessScore": 70,
    "rules": [
      {
        "role": "implementer",
        "presets": ["dotnet"],
        "minComplexity": 3,
        "agent": { "type": "claude", "model": "configured-dotnet-model" },
      },
    ],
  },
  "execution": {
    "concurrency": 1,
    "taskTimeoutMs": 3600000,
    "maxRepairAttempts": 3,
    "maxRepeatedFailure": 2,
    "leaseMs": 60000,
    "portRange": { "start": 41000, "end": 41999 },
    "portEnv": ["PORT", "SLICEFORGE_PORT"],
  },
  "evaluation": {
    "repetitions": 10,
    "contextVariants": ["original", "reordered", "irrelevant", "reduced"],
    "maxSuccessRateRegression": 0.05,
    "requireSchemaCompliance": true,
  },
  "inputs": {
    "maxAttachmentBytes": 10485760,
  },
  "documentation": {
    "defaultImpact": "review",
    "requireReviewWhenUncertain": true,
  },
  "reporting": {
    "directory": "reports",
    "retainRuns": 50,
    "maxLogBytes": 1048576,
  },
  "ci": { "reportOnly": true },
}
```

`execution.concurrency` controls how many independent tasks may run at once. Slices inside one task follow their dependency order and are integrated into that task's staging worktree. Tasks that share a target are serialized. Network-capable runs on different targets use unique machine-wide TTL port leases from `execution.portRange`; the selected value is injected through every name in `execution.portEnv` to implementer, preparation, integration, E2E, browser and review processes. Rebase and `verify --ci` obtain fresh leases. Concurrency does not bypass approval and never promotes a bundle automatically.

The port registry is stored in the OS application-data directory and contains only owner IDs, ports and timestamps. It coordinates separate repositories on the same machine. A configured range must be ordered, use ports `1024..65535`, and contain no more than 10,000 ports. SliceForge skips ports already bound by external processes and fails closed when the range is exhausted.

`routing.rules` are evaluated in order for clarifier, planner, implementer, testgen and reviewer roles. A rule may constrain target names, target presets and an auditable complexity score from 1 to 5. The first matching rule selects its agent; when no rule matches, the agent configured for that role under `agents` is used. Agent failure never silently falls through to another model. Unknown targets, inverted complexity ranges and missing generic-command capabilities are configuration errors, and `doctor` checks every routed executable.

Generic command agents must declare capabilities explicitly:

```jsonc
{
  "type": "command",
  "command": "my-sliceforge-agent",
  "args": [],
  "capabilities": ["clarifier", "planner", "implementer", "testgen", "reviewer"],
}
```

They receive one JSON request on stdin, write human logs to stderr, and return exactly one schema-valid JSON response on stdout.

Published protocol schemas:

- `@zeroltv/sliceforge/schemas/agent-request.schema.json`
- `@zeroltv/sliceforge/schemas/agent-response.schema.json`
- `@zeroltv/sliceforge/schemas/evaluation-suite.schema.json`

`clarifier` and `planner` are optional config roles. When present, SliceForge invokes them in disposable detached worktrees and rejects any mutation, malformed output, unknown field or role/output mismatch. When absent, that stage uses the deterministic readiness or graph proposal. A configured role never silently falls back after protocol failure.

Clarifier output has `kind: "clarification"`, an integer readiness score, assumptions, and at most three questions. Every returned question must also be listed as a blocker. Planner output has `kind: "plan"`, one or more slices, assumptions, risks and optional `estimatedCostUSD`. SliceForge then validates the proposal against plan schema, selected targets, path ownership, dependency cycles, globally unique acceptance IDs and required evidence tied to declared executable gates or artifacts.

`targets.<name>.prepare` runs once per affected target, in dependency order, before validation commands. It is intended for deterministic dependency restoration such as `npm ci`, `dotnet restore`, `poetry install`, or Gradle/Maven dependency preparation. Preparation runs only in a detached validation worktree; any tracked or untracked mutation makes the run fail.

`reporting.directory` is runtime-relative. SliceForge resolves it below `<git-common-dir>/sliceforge/`, never below the project working tree. Omitting it uses the runtime `reports` directory.

## Plan Format

`sliceforge.plan.yaml` contains dependency-ordered slices. Acceptance IDs are globally unique.

```yaml
schemaVersion: 1
slices:
  - id: checkout-validation
    title: Validate checkout requests
    priority: 1
    targets: [api]
    acceptance:
      - id: CHECKOUT-001
        given: an invalid card token
        when: checkout is submitted
        then: the API returns a validation error
    allowedPaths: [services/api/src/**, services/api/tests/**]
    requiredArtifacts: [services/api/tests/checkout.test.ts]
    requiredGates: [artifact, build, lint, unit, review]
    docsImpact: review
    evidence:
      - acceptanceId: CHECKOUT-001
        kind: test
        source: unit
        required: true
    retryPolicy:
      maxAttempts: 3
```

When `requiredGates` is present, only those gates run; target dependencies still run first. Only deterministic gate failure triggers automatic retry. Protocol, policy, capability and reviewer-mutation failures stop immediately.

`docsImpact: required` requires a declared Markdown documentation artifact. The artifact gate rejects missing, empty, escaping, symlinked and broken local links. External HTTP links are recorded but are not fetched by SliceForge. Independently of the planner label, changing a CLI, package export, schema, controller, route, OpenAPI/GraphQL/protobuf or public source surface without an existing changed Markdown file creates a deterministic `docs-impact` warning and moves the run to `needs_attention`. SliceForge does not invent unrelated documentation; a human can revise the task or explicitly accept the checkpoint.

## Browser Gate

An enabled browser gate requires a deterministic command and JSON report:

```jsonc
"browser": {
  "enabled": true,
  "command": { "command": "npx", "args": ["playwright", "test", "--reporter=json"] },
  "reportPath": "artifacts/playwright-report.json",
  "visual": {
    "artifactDirectory": "artifacts/visual",
    "manifestPath": "artifacts/visual/manifest.json",
    "baselineDirectory": "tests/visual-baselines",
    "requiredViewports": [
      { "id": "desktop", "width": 1280, "height": 720 },
      { "id": "mobile", "width": 390, "height": 844 }
    ],
    "maxDiffRatio": 0.001,
    "pixelThreshold": 0.1,
    "maxScreenshotBytes": 5242880,
    "requireNoRuntimeErrors": true,
    "requireNoOverflow": true,
    "requireAccessibility": true,
    "requireAssets": true
  }
}
```

The command exit code and parsed JSON report must both pass. If `visual` is configured, the command must also create a manifest matching `@zeroltv/sliceforge/schemas/visual-manifest.schema.json`. Every required viewport needs one safe PNG under `artifactDirectory`. SliceForge verifies PNG dimensions, structured runtime/overflow/accessibility/missing-asset findings and pixel differences against `<baselineDirectory>/<viewport-id>.png`.

Baseline PNGs are reviewed, tracked project inputs. Generated screenshots, manifest and diff PNGs are disposable gate artifacts and cannot point at source paths or symlinks. `maxDiffRatio` controls the allowed changed-pixel fraction; `pixelThreshold` controls per-pixel color sensitivity. Omitting `baselineDirectory` keeps the other deterministic checks but `doctor` warns that visual regression comparison is disabled. AI cannot declare a browser or visual gate successful.

## Optional Figma Provider

SliceForge never connects to Figma by itself. Configure a local command only when needed:

```jsonc
"inputs": {
  "maxAttachmentBytes": 10485760,
  "figmaProvider": {
    "command": "my-figma-context-provider",
    "envAllowlist": ["FIGMA_TOKEN"],
    "timeoutMs": 60000
  }
}
```

The provider receives `{ protocolVersion, taskId, figmaUrl }` on stdin and returns one JSON document on stdout. Human logs go to stderr. The sanitized JSON is stored under the local task runtime directory and fingerprinted.

## Evaluation Suite Protocol

```json
{
  "name": "model-regression",
  "command": { "command": "node", "args": ["tools/evaluate-task.mjs"] },
  "cases": [{ "id": "user-screen", "input": { "request": "Build user screen" } }]
}
```

The command runs once per repetition and context variant. Each case should declare `allowedPaths` and may provide `context` plus `irrelevantContext` arrays. SliceForge, not the evaluator command, creates deterministic variants: `reordered` reverses context order, `irrelevant` appends the declared unrelated entries (or a fixed harmless marker), and `reduced` removes the final context entry. The command receives both the unchanged `input` and the transformed `context` through stdin and returns raw evidence:

```json
{
  "acceptance": [{ "id": "AC-1", "verified": true, "evidence": ["unit:user-screen"] }],
  "claims": [{ "statement": "The behavior passed", "evidence": ["unit:user-screen"] }],
  "changedFiles": ["src/user-screen.ts"],
  "gates": [{ "id": "unit:user-screen", "status": "passed" }],
  "retries": 0,
  "costUSD": 0.02,
  "output": { "result": "stable" }
}
```

SliceForge strictly parses this response and computes compliance, policy violations, unsupported claims, behavior and changed-file fingerprints, flaky gates and success. Invalid JSON or nonzero exit becomes a failed trial instead of aborting the suite. Defaults are ten repetitions, four context variants, 100% schema compliance and at most a five percentage-point success regression. A run also fails without a baseline when any trial fails, required evidence is incomplete, a claim is unsupported, a gate is flaky, a secret is detected, repeated trials disagree, or behavior/changed-file sets change across context variants.

`eval run <suite> --baseline <name>` checks that the baseline exists before executing any trial. The comparison records the configured agent/model identifiers and detected CLI versions. An agent version change is reported as provenance drift and may pass only when all deterministic regression rules still pass. A changed suite, harness configuration fingerprint or context fingerprint invalidates the comparison and blocks it; accept a new baseline only after reviewing why that input changed.

For plans with more than one acceptance criterion, every criterion requires an explicit `evidence` mapping. `unverified` evidence is never promotable; `manual_required` needs `promote --accept-attention`.
