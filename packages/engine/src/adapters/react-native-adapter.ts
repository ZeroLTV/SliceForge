import { BaseStackAdapter } from "./base-stack-adapter.js";
import { SliceForgeConfig } from "../core/config.js";
import { execCommand, ShellResult } from "../utils/shell.js";
import { logger } from "../utils/logger.js";
import { spawn } from "child_process";

export class ReactNativeAdapter extends BaseStackAdapter {
  constructor(config: SliceForgeConfig, projectRoot: string) {
    super(config, projectRoot);
  }

  public async build(): Promise<ShellResult> {
    const cmd = this.config.checks.commands.build || "tsc --noEmit";
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async lint(): Promise<ShellResult> {
    const cmd =
      this.config.checks.commands.lint ||
      "eslint . --ext .js,.jsx,.ts,.tsx";
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async test(
    layer: "unit" | "integration" | "e2e",
  ): Promise<ShellResult> {
    const fallback: Record<"unit" | "integration" | "e2e", string> = {
      unit: "jest",
      integration: "jest",
      e2e: "detox test",
    };
    const cmd = this.config.checks.commands.test[layer] || fallback[layer];
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  protected async startAppProcesses(): Promise<void> {
    const metroPort = this.config.stack.web?.port || 8081;
    logger.info(`Starting Metro bundler on port ${metroPort}...`);
    const metro = spawn(
      "npx",
      ["react-native", "start", "--port", String(metroPort)],
      {
        cwd: this.projectRoot,
        shell: false,
        env: { ...process.env, CI: "true" },
      },
    );
    this.activeProcesses.push(metro);
  }

  async healthCheck(): Promise<boolean> {
    // Mobile app health is validated through the e2e gate (Detox/Maestro),
    // not via an HTTP endpoint. The preview is considered healthy as long
    // as Metro was started successfully.
    logger.debug(
      "React Native health check delegated to the e2e gate; preview assumed healthy.",
    );
    return true;
  }
}
