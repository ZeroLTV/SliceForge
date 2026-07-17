import { describe, expect, it, jest } from "@jest/globals";

const registeredCommands: string[] = [];
const registeredOptions: string[] = [];
const metadata = { name: "", description: "", version: "", parsed: false };
const packageMetadata = require("../../package.json") as { version: string };

const commandInstance = {
  name: jest.fn((value: string) => {
    metadata.name = value;
    return commandInstance;
  }),
  description: jest.fn((value: string) => {
    if (!metadata.description) metadata.description = value;
    return commandInstance;
  }),
  version: jest.fn((value: string) => {
    metadata.version = value;
    return commandInstance;
  }),
  command: jest.fn((value: string) => {
    registeredCommands.push(value);
    return commandInstance;
  }),
  option: jest.fn((value: string) => {
    registeredOptions.push(value);
    return commandInstance;
  }),
  requiredOption: jest.fn((value: string) => {
    registeredOptions.push(value);
    return commandInstance;
  }),
  action: jest.fn(() => commandInstance),
  parseAsync: jest.fn(async () => {
    metadata.parsed = true;
    return commandInstance;
  }),
};

jest.mock("commander", () => ({ Command: jest.fn(() => commandInstance) }));
jest.mock("../../src/core/onboarding", () => ({
  initializeProject: jest.fn(),
}));
jest.mock("../../src/core/config-loader", () => ({
  loadConfig: jest.fn(),
  loadPlan: jest.fn(),
  validateProject: jest.fn(),
}));
jest.mock("../../src/core/doctor", () => ({ runDoctor: jest.fn() }));
jest.mock("../../src/core/orchestrator", () => ({
  SliceForgeOrchestrator: jest.fn(() => ({})),
}));

require("../../src/cli/index");

describe("SliceForge CLI contract", () => {
  it("publishes the first stable identity", () => {
    expect(metadata).toMatchObject({
      name: "sliceforge",
      version: packageMetadata.version,
      parsed: true,
    });
    expect(metadata.description).toContain("SliceForge");
  });

  it("registers every public command", () => {
    expect(registeredCommands).toEqual(
      expect.arrayContaining([
        "init",
        "doctor",
        "plan",
        "validate",
        "do <request>",
        "task",
        "list",
        "inspect <taskId>",
        "answer <taskId>",
        "approve <taskId>",
        "revise <taskId>",
        "accept-attention <taskId>",
        "cancel <taskId>",
        "queue",
        "start",
        "pause",
        "resume",
        "eval",
        "run <suite>",
        "compare <runId>",
        "accept-baseline <runId>",
        "run [sliceId]",
        "resume <runId>",
        "testgen [sliceId]",
        "status",
        "inspect <runId>",
        "report <runId>",
        "promote <runId>",
        "rebase <runId>",
        "cancel <runId>",
        "clean",
        "verify [sliceId]",
      ]),
    );
  });

  it("registers explicit safety and CI options", () => {
    expect(registeredOptions).toEqual(
      expect.arrayContaining([
        "--agent <agent>",
        "-y, --yes",
        "--force",
        "--json",
        "--accept-review",
        "--accept-attention",
        "--ci",
        "--from <file>",
        "--image <path>",
        "--figma <url>",
        "--set <answer>",
        "--concurrency <number>",
        "--watch",
        "--poll-ms <number>",
        "--feedback <text>",
        "--baseline <name>",
      ]),
    );
  });
});
