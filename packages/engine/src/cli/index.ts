#!/usr/bin/env node

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../core/config.js";
import { runRalphLoop, approveSlice } from "../core/ralph-runner.js";
import { runTestGenLoop } from "../core/testgen-runner.js";
import { loadBacklog } from "../core/backlog.js";
import { loadState } from "../core/state.js";
import { logger } from "../utils/logger.js";

const program = new Command();

process.on("uncaughtException", (err) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error(`Uncaught Exception: ${message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  const message =
    reason instanceof Error ? reason.message : String(reason);
  logger.error(`Unhandled Rejection: ${message}`);
  process.exit(1);
});

program
  .name("sliceforge")
  .description("SliceForge — Reusable AI Harness Engine CLI")
  .version("1.0.0");

program
  .command("init")
  .description("Initialize SliceForge configuration in the current directory")
  .action(() => {
    const cwd = process.cwd();
    const configPath = path.join(cwd, "sliceforge.config.json");
    const backlogPath = path.join(cwd, "whole-app-backlog.json");

    logger.info(`Initializing SliceForge in ${cwd}...`);

    if (fs.existsSync(configPath)) {
      logger.warn(
        "sliceforge.config.json already exists. Skipping config initialization.",
      );
    } else {
      const defaultConfig = {
        project: "my-sliceforge-app",
        agent: {
          type: "api",
          model: "claude-3-5-sonnet-20241022",
        },
        stack: {
          type: "node",
        },
        checks: {
          commands: {
            build: "npm run build",
            lint: "npm run lint",
            test: {
              unit: "npm run test:unit",
            },
          },
        },
        loop: {
          maxIterations: 10,
          maxRetriesPerSlice: 3,
          requireHumanApproval: ["security", "schema"],
          browserTest: {
            required: false,
            requirePreviewStack: false,
          },
          testCaseGate: "warn",
        },
      };
      fs.writeFileSync(
        configPath,
        JSON.stringify(defaultConfig, null, 2),
        "utf8",
      );
      logger.success("Created default sliceforge.config.json");
    }

    if (fs.existsSync(backlogPath)) {
      logger.warn(
        "whole-app-backlog.json already exists. Skipping backlog initialization.",
      );
    } else {
      const defaultBacklog = {
        branchName: "main",
        slices: [
          {
            id: "slice-1",
            passes: false,
            priority: 1,
            description: "Bootstrap minimal project workspace structure",
            tags: ["setup"],
          },
        ],
      };
      fs.writeFileSync(
        backlogPath,
        JSON.stringify(defaultBacklog, null, 2),
        "utf8",
      );
      logger.success("Created sample whole-app-backlog.json");
    }
  });

program
  .command("loop")
  .description("Run the Ralph Loop continuously to implement backlog slices")
  .option("-m, --max <iterations>", "Maximum loop iterations override")
  .action(async (options) => {
    const cwd = process.cwd();
    const config = loadConfig(cwd);

    const logFilePath = path.isAbsolute(config.paths.state)
      ? path.join(path.dirname(config.paths.state), "sliceforge.log")
      : path.join(cwd, "sliceforge.log");
    logger.setLogFile(logFilePath);

    if (options.max) {
      config.loop.maxIterations = parseInt(options.max, 10);
    }

    await runRalphLoop(config, cwd, false);
  });

program
  .command("once")
  .description(
    "Run a single Ralph iteration (pick -> implement -> verify)",
  )
  .action(async () => {
    const cwd = process.cwd();
    const config = loadConfig(cwd);
    logger.setLogFile(path.join(cwd, "sliceforge.log"));

    await runRalphLoop(config, cwd, true);
  });

program
  .command("testgen")
  .description(
    "Run the TestGen Loop to generate test cases from spec documents",
  )
  .option("-o, --once", "Generate test cases for exactly one tag and stop")
  .action(async (options) => {
    const cwd = process.cwd();
    const config = loadConfig(cwd);
    logger.setLogFile(path.join(cwd, "sliceforge.log"));

    await runTestGenLoop(config, cwd, !!options.once);
  });

program
  .command("status")
  .description("Print current backlog and implementation status")
  .action(() => {
    const cwd = process.cwd();
    try {
      const config = loadConfig(cwd);
      const backlogPath = path.isAbsolute(config.paths.backlog)
        ? config.paths.backlog
        : path.join(cwd, config.paths.backlog);
      const statePath = path.isAbsolute(config.paths.state)
        ? config.paths.state
        : path.join(cwd, config.paths.state);

      const backlog = loadBacklog(backlogPath);
      const state = loadState(statePath);

      const completed = backlog.slices.filter((s) => s.passes).length;
      const total = backlog.slices.length;
      const pct =
        total > 0 ? Math.round((completed / total) * 100) : 0;

      logger.section(`SliceForge Status: ${config.project}`);
      console.log(
        `Backlog Completion: ${completed}/${total} slices (${pct}%)`,
      );
      console.log(`Loop State status:   ${state.status.toUpperCase()}`);
      if (state.currentSliceId) {
        console.log(`Current Active Slice: ${state.currentSliceId}`);
      }
      if (state.costAccumulated.estimatedCostUSD !== undefined) {
        console.log(
          `API Cost Accumulated: $${state.costAccumulated.estimatedCostUSD.toFixed(4)}`,
        );
      }

      console.log("\nSlices list:");
      for (const slice of backlog.slices) {
        const marker = slice.passes
          ? "\x1b[32m[x]\x1b[0m"
          : "\x1b[33m[ ]\x1b[0m";
        console.log(
          `  ${marker} ${slice.id} (Priority: ${slice.priority}) - ${slice.description}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to retrieve status: ${message}`);
    }
  });

program
  .command("approve <sliceId>")
  .description(
    "Approve and commit a slice currently pending human review",
  )
  .action(async (sliceId) => {
    const cwd = process.cwd();
    const config = loadConfig(cwd);
    logger.setLogFile(path.join(cwd, "sliceforge.log"));

    await approveSlice(config, cwd, sliceId);
  });

program.parse(process.argv);
