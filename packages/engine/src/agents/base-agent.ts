export enum AgentSignal {
  SLICE_DONE = "SLICE_DONE",
  BROWSER_TEST_PASS = "BROWSER_TEST_PASS",
  REVIEW_PASS = "REVIEW_PASS",
  ERROR = "ERROR",
}

export interface AgentRunOptions {
  cwd: string;
  timeoutMs?: number;
  model?: string;
  apiKey?: string;
}

export interface AgentResult {
  signal: AgentSignal;
  output: string;
  exitCode: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUSD?: number;
  };
}

export interface AgentAdapter {
  run(prompt: string, options: AgentRunOptions): Promise<AgentResult>;
}

export function parseAgentSignal(output: string): AgentSignal {
  if (output.includes("SLICE_DONE")) return AgentSignal.SLICE_DONE;
  if (output.includes("BROWSER_TEST_PASS")) return AgentSignal.BROWSER_TEST_PASS;
  if (output.includes("REVIEW_PASS")) return AgentSignal.REVIEW_PASS;
  return AgentSignal.ERROR;
}
