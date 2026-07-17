# Minimal Node Example

This fixture demonstrates SliceForge structured commands, YAML slices, worktree isolation and manual promotion.

## Run Locally

```bash
cd /path/to/SliceForge
npm ci
npm run build
npm link --workspace packages/engine

cd examples/minimal-node
npm link @zeroltv/sliceforge
sliceforge doctor
sliceforge plan validate
sliceforge run first-slice
sliceforge status
sliceforge promote <run-id>
```

Configure and authenticate the Codex CLI before `run`. SliceForge does not read an API key directly or send telemetry; the selected agent CLI owns its authentication and network behavior.
