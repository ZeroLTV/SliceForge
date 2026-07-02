# Configuration Reference

SliceForge is configured using a single `sliceforge.config.json` file in the root of your project workspace.

## Options

- **`project`** (string, required): Name of your application.
- **`agent`** (object, required): AI agent runtime configurations.
  - `type` (string, required): Enum of `cursor-cli`, `claude-code`, `api`.
  - `model` (string, optional): Specific LLM model version (e.g. `claude-3-5-sonnet-20241022`).
  - `timeoutMs` (integer, optional): Agent timeout in milliseconds (default: 5 mins).
- **`stack`** (object, required): Development stack settings.
  - `type` (string, required): Enum of `node`, `dotnet`, `custom`.
  - `api` (object, optional): API port and path for health check.
    - `port` (integer)
    - `healthPath` (string)
  - `web` (object, optional): Web port and path for health check.
    - `port` (integer)
    - `healthPath` (string)
  - `db` (object, optional): Docker Compose DB configuration.
    - `compose` (string): Docker compose file name (default: `docker-compose.yml`).
    - `service` (string): Docker service container name (default: `db`).
- **`checks`** (object, required): Automated test and static analysis commands.
  - `commands` (object, required):
    - `build` (string): Build or typecheck command (e.g. `npm run build`).
    - `lint` (string, optional): Linting check (e.g. `npm run lint`).
    - `test` (object): Unit, integration, and E2E test commands.
  - `forbiddenPatterns` (array, optional): Rules containing patterns that shouldn't appear in code.
    - `id` (string): Rule name.
    - `pattern` (string): Regex matching forbidden code (e.g. `sqlite3` or local Maps).
    - `paths` (array of strings): Directory paths to scan.
    - `message` (string): Helpful message displayed upon violation.
- **`loop`** (object, required): Cycle rules.
  - `maxIterations` (integer): Maximum slice runs.
  - `maxRetriesPerSlice` (integer): Retry count limit before halting.
  - `requireHumanApproval` (array of strings, optional): Tags where loop pauses to request developer approval.
  - `browserTest` (object): Playwright browser test gates.
    - `required` (boolean)
    - `requirePreviewStack` (boolean)
  - `testCaseGate` (string): `required`, `warn`, or `skip`.
- **`paths`** (object, optional): Custom path configurations.
  - `backlog` (string): Path to backlog file (default: `whole-app-backlog.json`).
  - `testCases` (string): Path to test cases folder (default: `docs/test-cases/items`).
  - `guardrails` (string): Guardrails history file path (default: `docs/guardrails.md`).
  - `state` (string): State file path (default: `.sliceforge-state.json`).
  - `lock` (string): Lock file path (default: `.sliceforge.lock`).

## Example JSON Configuration

```json
{
  "project": "my-app",
  "agent": {
    "type": "api",
    "model": "claude-3-5-sonnet-20241022"
  },
  "stack": {
    "type": "node",
    "db": {
      "compose": "docker-compose.yml",
      "service": "postgres"
    }
  },
  "checks": {
    "commands": {
      "build": "npm run build",
      "lint": "npm run lint",
      "test": {
        "unit": "npm run test:unit"
      }
    }
  },
  "loop": {
    "maxIterations": 20,
    "maxRetriesPerSlice": 3,
    "requireHumanApproval": ["security"],
    "browserTest": {
      "required": false,
      "requirePreviewStack": false
    },
    "testCaseGate": "warn"
  }
}
```
