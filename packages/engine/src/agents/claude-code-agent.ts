import * as fs from "fs";
import * as path from "path";
import { AgentAdapter, AgentResult, AgentRunOptions } from "./base-agent.js";
import { spawnCommand } from "../utils/shell.js";
import { logger } from "../utils/logger.js";

export class ClaudeCodeAgent implements AgentAdapter {
  private cliPath: string;

  constructor(cliPath?: string) {
    this.cliPath = cliPath || "claude";
  }

  public async run(prompt: string, options: AgentRunOptions): Promise<AgentResult> {
    const promptPath = path.join(options.cwd, ".sliceforge-prompt.md");
    fs.writeFileSync(promptPath, prompt, "utf8");

    // For Claude Code CLI, we might run: claude --prompt-file <path> or pipe the prompt
    // Let's configure it with standard arguments
    const args = ["-p", ".sliceforge-prompt.md"];
    logger.info(`Starting Claude Code agent process: ${this.cliPath} ${args.join(" ")}`);

    try {
      const result = await spawnCommand(this.cliPath, args, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
      });

      if (fs.existsSync(promptPath)) {
        fs.unlinkSync(promptPath);
      }

      const signal = this.parseSignal(result.stdout + "\n" + result.stderr);
      return {
        signal,
        output: result.stdout,
        exitCode: result.exitCode,
      };
    } catch (err: any) {
      if (fs.existsSync(promptPath)) {
        fs.unlinkSync(promptPath);
      }
      return {
        signal: "ERROR",
        output: `Agent execution failed: ${err.message}`,
        exitCode: -1,
      };
    }
  }

  public parseSignal(output: string): string {
    if (output.includes("SLICE_DONE")) return "SLICE_DONE";
    if (output.includes("BROWSER_TEST_PASS")) return "BROWSER_TEST_PASS";
    if (output.includes("REVIEW_PASS")) return "REVIEW_PASS";
    return "ERROR";
  }
}
