import * as fs from "fs";
import * as path from "path";
import { AgentAdapter, AgentResult, AgentRunOptions, AgentSignal, parseAgentSignal } from "./base-agent.js";
import { spawnCommand } from "../utils/shell.js";
import { logger } from "../utils/logger.js";

export class CursorCliAgent implements AgentAdapter {
  private cliPath: string;

  constructor(cliPath?: string) {
    this.cliPath = cliPath || "cursor";
  }

  public async run(prompt: string, options: AgentRunOptions): Promise<AgentResult> {
    const promptPath = path.join(options.cwd, ".sliceforge-prompt.md");
    fs.writeFileSync(promptPath, prompt, "utf8");
    logger.debug(`Saved agent prompt to ${promptPath}`);

    const args = ["--prompt-file", ".sliceforge-prompt.md", "--force"];
    logger.info(`Starting Cursor CLI agent process: ${this.cliPath} ${args.join(" ")}`);

    try {
      const result = await spawnCommand(this.cliPath, args, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
      });

      cleanupPromptFile(promptPath);

      const signal = parseAgentSignal(result.stdout + "\n" + result.stderr);
      return {
        signal,
        output: result.stdout,
        exitCode: result.exitCode,
      };
    } catch (err) {
      cleanupPromptFile(promptPath);
      const message = err instanceof Error ? err.message : String(err);
      return {
        signal: AgentSignal.ERROR,
        output: `Agent execution failed: ${message}`,
        exitCode: -1,
      };
    }
  }
}

function cleanupPromptFile(promptPath: string): void {
  if (fs.existsSync(promptPath)) {
    fs.unlinkSync(promptPath);
  }
}
