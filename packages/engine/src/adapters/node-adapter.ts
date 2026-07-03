import { BaseStackAdapter } from "./base-stack-adapter.js";
import { SliceForgeConfig } from "../core/config.js";
import { execCommand, ShellResult } from "../utils/shell.js";
import { logger } from "../utils/logger.js";
import { spawn } from "child_process";

export class NodeAdapter extends BaseStackAdapter {
  constructor(config: SliceForgeConfig, projectRoot: string) {
    super(config, projectRoot);
  }

  public async build(): Promise<ShellResult> {
    const cmd = this.config.checks.commands.build;
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async lint(): Promise<ShellResult> {
    const cmd = this.config.checks.commands.lint;
    if (!cmd) {
      return {
        stdout: "Linting skipped (no command specified)",
        stderr: "",
        exitCode: 0,
      };
    }
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async test(
    layer: "unit" | "integration" | "e2e",
  ): Promise<ShellResult> {
    const cmd = this.config.checks.commands.test[layer];
    if (!cmd) {
      return {
        stdout: `Test layer '${layer}' skipped (no command specified)`,
        stderr: "",
        exitCode: 0,
      };
    }
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  protected async startAppProcesses(): Promise<void> {
    const apiPort = this.config.stack.api?.port;
    if (apiPort) {
      logger.info(`Starting API server on port ${apiPort}...`);
      const apiProcess = spawn("npm", ["run", "start:api"], {
        cwd: this.projectRoot,
        shell: false,
      });
      this.activeProcesses.push(apiProcess);
    }

    const webPort = this.config.stack.web?.port;
    if (webPort) {
      logger.info(`Starting Web server on port ${webPort}...`);
      const webProcess = spawn("npm", ["run", "start:web"], {
        cwd: this.projectRoot,
        shell: false,
      });
      this.activeProcesses.push(webProcess);
    }
  }
}
