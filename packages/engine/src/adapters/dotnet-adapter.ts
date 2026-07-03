import { BaseStackAdapter } from "./base-stack-adapter.js";
import { SliceForgeConfig } from "../core/config.js";
import { execCommand, ShellResult } from "../utils/shell.js";
import { logger } from "../utils/logger.js";
import { spawn } from "child_process";

export class DotnetAdapter extends BaseStackAdapter {
  constructor(config: SliceForgeConfig, projectRoot: string) {
    super(config, projectRoot);
  }

  public async build(): Promise<ShellResult> {
    const cmd = this.config.checks.commands.build || "dotnet build --no-restore";
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async lint(): Promise<ShellResult> {
    const cmd =
      this.config.checks.commands.lint || "dotnet format --verify-no-changes";
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async test(
    layer: "unit" | "integration" | "e2e",
  ): Promise<ShellResult> {
    const defaultCmd = `dotnet test --filter Category=${
      layer.charAt(0).toUpperCase() + layer.slice(1)
    }`;
    const cmd = this.config.checks.commands.test[layer] || defaultCmd;
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  protected async startAppProcesses(): Promise<void> {
    const apiPort = this.config.stack.api?.port;
    if (apiPort) {
      logger.info(`Starting .NET API on port ${apiPort}...`);
      const apiProcess = spawn("dotnet", ["run"], {
        cwd: this.projectRoot,
        shell: false,
      });
      this.activeProcesses.push(apiProcess);
    }
  }
}
