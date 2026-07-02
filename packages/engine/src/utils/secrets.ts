import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { logger } from "./logger.js";

export function loadAndValidateSecrets(projectRoot: string, agentType: "cursor-cli" | "claude-code" | "api"): Record<string, string> {
  const envPath = path.join(projectRoot, ".env");
  if (fs.existsSync(envPath)) {
    logger.debug(`Loading .env from ${envPath}`);
    dotenv.config({ path: envPath });
  } else {
    logger.warn(`No .env file found at ${envPath}. Using existing process environment.`);
  }

  const secrets: Record<string, string> = {};
  const missingKeys: string[] = [];

  const checkKey = (key: string, required: boolean) => {
    const value = process.env[key] || "";
    if (required && !value) {
      missingKeys.push(key);
    }
    secrets[key] = value;
  };

  // Agent-specific validation
  if (agentType === "api") {
    // Direct API needs either ANTHROPIC_API_KEY or OPENAI_API_KEY
    const anthropic = process.env.ANTHROPIC_API_KEY || "";
    const openai = process.env.OPENAI_API_KEY || "";
    if (!anthropic && !openai) {
      missingKeys.push("ANTHROPIC_API_KEY or OPENAI_API_KEY");
    }
    secrets["ANTHROPIC_API_KEY"] = anthropic;
    secrets["OPENAI_API_KEY"] = openai;
  } else if (agentType === "cursor-cli") {
    checkKey("CURSOR_CLI_PATH", false); // Optional, default is just 'cursor'
  } else if (agentType === "claude-code") {
    checkKey("CLAUDE_CODE_PATH", false); // Optional, default is just 'claude'
  }

  if (missingKeys.length > 0) {
    const errorMsg = `Missing required environment variables for agent type '${agentType}': ${missingKeys.join(", ")}`;
    logger.error(errorMsg);
    throw new Error(errorMsg);
  }

  return secrets;
}
