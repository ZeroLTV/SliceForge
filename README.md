# SliceForge

[![CI Status](https://github.com/ZeroLTV/SliceForge/actions/workflows/ci.yml/badge.svg)](https://github.com/ZeroLTV/SliceForge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**SliceForge** is a reusable AI Harness Engine that automates the development cycle for any tech stack. By separating the automation engine from project-specific configurations, it allows AI coding agents to implement and verify applications slice-by-slice under rigorous local guardrails.

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

## Features

- **Spec-Driven Test Generation:** Auto-generates test scenarios from design documents.
- **Incremental Implementation (Ralph Loop):** Picks, implements, and tests one backlog slice at a time.
- **Multi-Gate Validation:** Enforces compiler checks, forbidden patterns, live preview verification, browser functional testing (Playwright), and static AI code reviews.
- **State Persistence & Resume:** Resumes interrupted loop execution safely.
- **Git Rollback Guard:** Resets workspace dirty state before retrying slice implementation.
- **Human Approval Hooks:** Stops loop execution at pre-defined checkpoints for developer approval.

## Quick Start

### 1. Installation
Install the CLI tool locally or globally:
```bash
npm install -g @zeroltv/sliceforge
```

### 2. Initialize a Project
Create configuration templates in your project folder:
```bash
sliceforge init
```
This generates `sliceforge.config.json` and a blank `whole-app-backlog.json`.

### 3. Start the Loop
Run the automation loop:
```bash
sliceforge loop
```

For more details, check [Getting Started](docs/getting-started.md).

## License

MIT License. See [LICENSE](LICENSE) for more details.
