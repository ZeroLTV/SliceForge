import { StackAdapter } from "../adapters/base-adapter.js";
import { SliceForgeConfig } from "../core/config.js";
import { logger } from "../utils/logger.js";
import * as net from "net";

function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (err: any) => {
      if (err.code === "EADDRINUSE") {
        resolve(true);
      } else {
        resolve(false);
      }
    });
    server.once("listening", () => {
      server.close();
      resolve(false);
    });
    server.listen(port);
  });
}

export async function startPreviewStack(
  config: SliceForgeConfig,
  stackAdapter: StackAdapter,
): Promise<void> {
  logger.step("Starting preview stack");

  // 1. Port conflict check
  const portsToCheck: { name: string; port: number }[] = [];
  if (config.stack.api?.port) {
    portsToCheck.push({ name: "API", port: config.stack.api.port });
  }
  if (config.stack.web?.port) {
    portsToCheck.push({ name: "Web", port: config.stack.web.port });
  }

  for (const { name, port } of portsToCheck) {
    const inUse = await isPortInUse(port);
    if (inUse) {
      const errorMsg = `Port conflict detected: ${name} port ${port} is already in use on this machine. Please free the port before running SliceForge.`;
      logger.error(errorMsg);
      throw new Error(errorMsg);
    }
  }

  // 2. Start stack via adapter
  try {
    await stackAdapter.startPreview();
  } catch (err: any) {
    logger.error(`Failed to start preview stack: ${err.message}`);
    throw err;
  }

  // 3. Polling health check
  logger.info("Waiting for preview stack to become healthy...");
  const maxRetries = 30; // 30 seconds max wait
  let retries = 0;
  let healthy = false;

  while (retries < maxRetries) {
    healthy = await stackAdapter.healthCheck();
    if (healthy) {
      break;
    }
    retries++;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!healthy) {
    const errorMsg = "Preview stack failed healthcheck within timeout period.";
    logger.error(errorMsg);
    // Cleanup if start succeeded but healthcheck failed
    try {
      await stackAdapter.stopPreview();
    } catch (_cleanupErr) {
      // Ignore cleanup error to throw original healthcheck failure
    }
    throw new Error(errorMsg);
  }

  logger.success("Preview stack is healthy and ready.");
}

export async function stopPreviewStack(stackAdapter: StackAdapter): Promise<void> {
  logger.step("Stopping preview stack");
  try {
    await stackAdapter.stopPreview();
    logger.success("Preview stack stopped successfully.");
  } catch (err: any) {
    logger.error(`Error occurred while stopping preview stack: ${err.message}`);
    // Still throw or handle depending on severity, let's log and pass since it's cleanup
  }
}
