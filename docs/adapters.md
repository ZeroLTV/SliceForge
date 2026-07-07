# Implementing Custom Stack Adapters

SliceForge supports various language ecosystems using the `StackAdapter` interface.

## Interface Definition

Your custom stack adapter must implement the `StackAdapter` interface:

```typescript
import { ShellResult } from "../utils/shell.js";

export interface StackAdapter {
  build(): Promise<ShellResult>;
  lint(): Promise<ShellResult>;
  test(layer: "unit" | "integration" | "e2e"): Promise<ShellResult>;
  startPreview(): Promise<void>;
  stopPreview(): Promise<void>;
  healthCheck(): Promise<boolean>;
}
```

## Adding Your Adapter

To register a new adapter (e.g. `FlutterAdapter` or `JavaAdapter`):

1. Create a new adapter file: `src/adapters/flutter-adapter.ts`.
2. Implement the `StackAdapter` interface methods, mapping `build`, `lint`, and `test` to appropriate CLI command executions.
3. Import and map it in `packages/engine/src/core/ralph-runner.ts` inside `getStackAdapter`.
4. Add the new `type` to the `stack.type` enum in `src/schemas/config.schema.json` and to the `SliceForgeConfig` union in `src/core/config.ts`, otherwise `loadConfig` will reject it.

```typescript
export function getStackAdapter(config: SliceForgeConfig, projectRoot: string): StackAdapter {
  switch (config.stack.type) {
    case "node":
      return new NodeAdapter(config, projectRoot);
    case "dotnet":
      return new DotnetAdapter(config, projectRoot);
    case "react-native":
      return new ReactNativeAdapter(config, projectRoot);
    case "flutter":
      return new FlutterAdapter(config, projectRoot); // Add registration
    default:
      throw new Error(`Unsupported stack type: ${config.stack.type}`);
  }
}
```

## Example: React Native

React Native is supported out of the box via `ReactNativeAdapter`. Because RN uses
the same JS/TS toolchain as Node, `build`/`lint`/`test` simply delegate to the
commands configured in `checks.commands` (with RN-friendly fallbacks: `tsc --noEmit`,
`eslint`, `jest`, `detox test`).

```jsonc
{
  "project": "my-rn-app",
  "agent": { "type": "api", "model": "claude-3-5-sonnet-20241022" },
  "stack": { "type": "react-native" },
  "checks": {
    "commands": {
      "build": "tsc --noEmit",
      "lint": "eslint . --ext .ts,.tsx",
      "test": {
        "unit": "jest",
        "e2e": "detox test --configuration ios.sim.debug"
      }
    }
  },
  "loop": {
    "maxIterations": 10,
    "maxRetriesPerSlice": 3,
    "browserTest": { "required": false, "requirePreviewStack": false },
    "testCaseGate": "warn"
  }
}
```

Notes:
- The **browser-test gate (Playwright)** is web-oriented and does not apply to native
  mobile. Set `loop.browserTest.required = false` and validate the UI through the
  `test.e2e` command (Detox/Maestro) instead.
- The preview stack starts the **Metro bundler** (default port `8081`, configurable
  via `stack.web.port`). Mobile app health is delegated to the e2e gate rather than an
  HTTP endpoint, so `healthCheck()` always returns `true` once the preview is up.
