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
3. Import and map it in `packages/engine/src/core/ralph-runner.ts` inside `getStackAdapter`:

```typescript
export function getStackAdapter(config: SliceForgeConfig, projectRoot: string): StackAdapter {
  switch (config.stack.type) {
    case "node":
      return new NodeAdapter(config, projectRoot);
    case "dotnet":
      return new DotnetAdapter(config, projectRoot);
    case "flutter":
      return new FlutterAdapter(config, projectRoot); // Add registration
    default:
      throw new Error(`Unsupported stack type: ${config.stack.type}`);
  }
}
```
