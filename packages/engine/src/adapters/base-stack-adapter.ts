import * as http from "http";
import { type ChildProcess } from "child_process";
import { type StackAdapter } from "./base-adapter.js";
import { type SliceForgeConfig } from "../core/config.js";
import { execCommand, killProcess } from "../utils/shell.js";
import { logger } from "../utils/logger.js";

export function checkPortHealth(port: number, path: string): Promise<boolean> {
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
}

export abstract class BaseStackAdapter implements StackAdapter {
  protected config: SliceForgeConfig;
  protected projectRoot: string;
  protected activeProcesses: ChildProcess[] = [];

  constructor(config: SliceForgeConfig, projectRoot: string) {
    this.config = config;
    this.projectRoot = projectRoot;
  }

  abstract build(): Promise<import("../utils/shell.js").ShellResult>;
  abstract lint(): Promise<import("../utils/shell.js").ShellResult>;
  abstract test(
    layer: "unit" | "integration" | "e2e",
  ): Promise<import("../utils/shell.js").ShellResult>;

  async startPreview(): Promise<void> {
    await this.startDbContainer();
    await this.startAppProcesses();
  }

  async stopPreview(): Promise<void> {
    await this.stopDbContainer();
    this.killAppProcesses();
    this.activeProcesses = [];
  }

  async healthCheck(): Promise<boolean> {
    const api = this.config.stack.api;
    if (api) {
      const apiHealthy = await checkPortHealth(api.port, api.healthPath);
      if (!apiHealthy) {
        logger.debug(`API health check failed on port ${api.port}`);
        return false;
      }
    }

    const web = this.config.stack.web;
    if (web) {
      const webHealthy = await checkPortHealth(web.port, web.healthPath);
      if (!webHealthy) {
        logger.debug(`Web health check failed on port ${web.port}`);
        return false;
      }
    }

    return true;
  }

  protected async startDbContainer(): Promise<void> {
    const db = this.config.stack.db;
    if (!db) return;

    const composeFile = db.compose || "docker-compose.yml";
    const service = db.service || "db";
    logger.info(
      `Starting DB container via Docker Compose: ${composeFile} (Service: ${service})`,
    );
    const res = await execCommand(
      `docker compose -f ${composeFile} up -d ${service}`,
      { cwd: this.projectRoot },
    );
    if (res.exitCode !== 0) {
      throw new Error(`Failed to start preview DB stack: ${res.stderr}`);
    }
    logger.success("Preview DB stack started successfully.");
  }

  protected async stopDbContainer(): Promise<void> {
    const db = this.config.stack.db;
    if (!db) return;

    const composeFile = db.compose || "docker-compose.yml";
    logger.info(`Stopping DB container via Docker Compose: ${composeFile}`);
    await execCommand(`docker compose -f ${composeFile} down`, {
      cwd: this.projectRoot,
    });
  }

  protected abstract startAppProcesses(): Promise<void>;

  protected killAppProcesses(): void {
    for (const proc of this.activeProcesses) {
      killProcess(proc);
    }
  }
}
