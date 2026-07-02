import { StackAdapter } from "./base-adapter.js";
import { SliceForgeConfig } from "../core/config.js";
import { execCommand, killProcess, ShellResult } from "../utils/shell.js";
import { logger } from "../utils/logger.js";
import * as http from "http";
import { spawn, ChildProcess } from "child_process";

export class NodeAdapter implements StackAdapter {
  private config: SliceForgeConfig;
  private projectRoot: string;
  private activeProcesses: ChildProcess[] = [];

  constructor(config: SliceForgeConfig, projectRoot: string) {
    this.config = config;
    this.projectRoot = projectRoot;
  }

  public async build(): Promise<ShellResult> {
    const cmd = this.config.checks.commands.build;
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async lint(): Promise<ShellResult> {
    const cmd = this.config.checks.commands.lint;
    if (!cmd) {
      return { stdout: "Linting skipped (no command specified)", stderr: "", exitCode: 0 };
    }
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async test(layer: "unit" | "integration" | "e2e"): Promise<ShellResult> {
    const cmd = this.config.checks.commands.test[layer];
    if (!cmd) {
      return { stdout: `Test layer '${layer}' skipped (no command specified)`, stderr: "", exitCode: 0 };
    }
    return execCommand(cmd, { cwd: this.projectRoot });
  }

  public async startPreview(): Promise<void> {
    // 1. DB Compose Up
    const db = this.config.stack.db;
    if (db) {
      const composeFile = db.compose || "docker-compose.yml";
      const service = db.service || "db";
      logger.info(`Starting DB container via Docker Compose: ${composeFile} (Service: ${service})`);
      const res = await execCommand(`docker compose -f ${composeFile} up -d ${service}`, {
        cwd: this.projectRoot,
      });
      if (res.exitCode !== 0) {
        throw new Error(`Failed to start preview DB stack: ${res.stderr}`);
      }
      logger.success("Preview DB stack started successfully.");
    }

    // 2. We can start Web and API if they are defined and running commands exist
    // For Node projects, normally we boot them using `npm run start` or custom commands.
    // Let's spawn them as processes so we can track and stop them
    const apiPort = this.config.stack.api?.port;
    if (apiPort) {
      logger.info(`Starting API server on port ${apiPort}...`);
      // Start API process (usually npm run dev or similar, let's execute in background)
      const apiProcess = spawn("npm", ["run", "start:api"], {
        cwd: this.projectRoot,
        shell: true,
      });
      this.activeProcesses.push(apiProcess);
    }

    const webPort = this.config.stack.web?.port;
    if (webPort) {
      logger.info(`Starting Web server on port ${webPort}...`);
      const webProcess = spawn("npm", ["run", "start:web"], {
        cwd: this.projectRoot,
        shell: true,
      });
      this.activeProcesses.push(webProcess);
    }
  }

  public async stopPreview(): Promise<void> {
    // Stop spawned processes
    // In our simplified NodeAdapter, we can also call docker compose down for DB
    const db = this.config.stack.db;
    if (db) {
      const composeFile = db.compose || "docker-compose.yml";
      logger.info(`Stopping DB container via Docker Compose: ${composeFile}`);
      await execCommand(`docker compose -f ${composeFile} down`, {
        cwd: this.projectRoot,
      });
    }

    // Killing background active processes
    for (const proc of this.activeProcesses) {
      killProcess(proc);
    }
    this.activeProcesses = [];
    logger.success("Preview stack stopped.");
  }

  public async healthCheck(): Promise<boolean> {
    // Helper to query port
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
      const apiHealthy = await checkPort(api.port, api.healthPath);
      if (!apiHealthy) {
        logger.debug(`API health check failed on port ${api.port}`);
        return false;
      }
    }

    const web = this.config.stack.web;
    if (web) {
      const webHealthy = await checkPort(web.port, web.healthPath);
      if (!webHealthy) {
        logger.debug(`Web health check failed on port ${web.port}`);
        return false;
      }
    }

    return true;
  }
}
