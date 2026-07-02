export interface AgentRunOptions {
  cwd: string;
  timeoutMs?: number;
  model?: string;
  apiKey?: string;
}

export interface AgentResult {
  signal: string; // 'SLICE_DONE' | 'BROWSER_TEST_PASS' | 'REVIEW_PASS' | 'ERROR'
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
