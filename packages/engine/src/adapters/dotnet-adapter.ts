import { StackAdapter } from "./base-adapter.js";
import { SliceForgeConfig } from "../core/config.js";
import { execCommand, killProcess, ShellResult } from "../utils/shell.js";
import { logger } from "../utils/logger.js";
import * as http from "http";
import { spawn, ChildProcess } from "child_process";

export class DotnetAdapter implements StackAdapter {
  private config: SliceForgeConfig;
  private projectRoot: string;
  private activeProcesses: ChildProcess[] = [];

  constructor(config: SliceForgeConfig, projectRoot: string) {
    this.config = config;
    this.projectRoot = projectRoot;
  }

  public async build(): Promise<ShellResult> {
    const cmd = this.config.checks.commands.build || "dotnet build --no-restore";
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async lint(): Promise<ShellResult> {
    const cmd = this.config.checks.commands.lint || "dotnet format --verify-no-changes";
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async test(layer: "unit" | "integration" | "e2e"): Promise<ShellResult> {
    const defaultCmd = `dotnet test --filter Category=${layer.charAt(0).toUpperCase() + layer.slice(1)}`;
    const cmd = this.config.checks.commands.test[layer] || defaultCmd;
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async startPreview(): Promise<void> {
    // DB Compose Up
    const db = this.config.stack.db;
    if (db) {
      const composeFile = db.compose || "docker-compose.yml";
      const service = db.service || "db";
      logger.info(`Starting .NET DB container via Docker Compose: ${composeFile}`);
      const res = await execCommand(`docker compose -f ${composeFile} up -d ${service}`, {
        cwd: this.projectRoot,
      });
      if (res.exitCode !== 0) {
        throw new Error(`Failed to start .NET DB stack: ${res.stderr}`);
      }
    }

    // Usually starts api via dotnet run
    const apiPort = this.config.stack.api?.port;
    if (apiPort) {
      logger.info(`Starting .NET API on port ${apiPort}...`);
      // Start in background (simplified mock for CLI execution)
      const apiProcess = spawn("dotnet", ["run"], {
        cwd: this.projectRoot,
        shell: true,
      });
      this.activeProcesses.push(apiProcess);
    }
  }

  public async stopPreview(): Promise<void> {
    const db = this.config.stack.db;
    if (db) {
      const composeFile = db.compose || "docker-compose.yml";
      logger.info(`Stopping .NET DB container via Docker Compose: ${composeFile}`);
      await execCommand(`docker compose -f ${composeFile} down`, {
        cwd: this.projectRoot,
      });
    }

    // Killing background active processes
    for (const proc of this.activeProcesses) {
      killProcess(proc);
    }
    this.activeProcesses = [];
  }

  public async healthCheck(): Promise<boolean> {
    const checkPort = (port: number, path: string): Promise<boolean> => {
      return new Promise((resolve) => {
        const req = http.request(
          {
            host: "localhost",
            port,
            path,
            method: "GET",
            timeout: 2000,
          },
          (res) => {
            resolve(res.statusCode === 200);
          },
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
          req.destroy();
          resolve(false);
        });
        req.end();
      });
    };

    const api = this.config.stack.api;
    if (api) {
      return checkPort(api.port, api.healthPath);
    }
    return true;
  }
}
