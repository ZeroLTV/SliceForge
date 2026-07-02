# SliceForge Architecture

SliceForge isolates environment automation from project details.

```
                    ┌─────────────────────────────────────┐
                    │          SliceForge Engine           │
                    │                                      │
  sliceforge loop ──►  RalphRunner                        │
  sliceforge testgen►  TestGenRunner                      │
  sliceforge approve►  ApprovalHandler                    │
                    │       │                              │
                    │       ▼                              │
                    │  PromptBuilder ──► AgentAdapter      │
                    │                   ├─ CursorCLI       │
                    │                   ├─ ClaudeCode      │
                    │                   └─ DirectAPI       │
                    │       │                              │
                    │       ▼                              │
                    │  [git rollback on retry]             │
                    │       │                              │
                    │       ▼                              │
                    │  ValidationGates                     │
                    │  ├─ checks (via StackAdapter)        │
                    │  ├─ preview-stack                    │
                    │  ├─ browser-test                     │
                    │  └─ ai-review                        │
                    │       │                              │
                    │  [human approval hook]               │
                    │       │                              │
                    │       ▼                              │
                    │  git commit → next slice             │
                    └─────────────────────────────────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               ▼                    ▼                     ▼
          NodeAdapter          DotnetAdapter     (CustomAdapter)
       npm build/lint/test  dotnet build/test   docs/adapters.md
```

## Modular Design

1. **CLI Layer (`src/cli/`)**: Command parsing and CLI logs formatting.
2. **Core Modules (`src/core/`)**: Core state transition, backlog handling, template rendering, and runner processes.
3. **Agent Adapters (`src/agents/`)**: CLI/API interfaces that delegate task inputs to agents like Cursor CLI, Claude Code, or OpenAI/Anthropic APIs.
4. **Stack Adapters (`src/adapters/`)**: Command builders for different technology stacks like Node, .NET Core. Custom stacks (e.g. Flutter/Java) are supported by adding custom adapters (see `docs/adapters.md`).
5. **Validation Gates (`src/gates/`)**: Automated gates evaluating agent edits (checks, preview stacked servers, Playwright UI, code reviews).
6. **Git/Lock Utilities (`src/utils/`)**: Concurrency safety locks and clean rollback resets before retrying steps.
