import { AgentAdapter, AgentResult, AgentRunOptions } from "./base-agent.js";
import { logger } from "../utils/logger.js";

export class ApiAgent implements AgentAdapter {
  public async run(prompt: string, options: AgentRunOptions): Promise<AgentResult> {
    const apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return {
        signal: "ERROR",
        output: "API Key is missing. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.",
        exitCode: -1,
      };
    }

    const isAnthropic = apiKey.startsWith("sk-ant") || !!process.env.ANTHROPIC_API_KEY;
    const model = options.model || (isAnthropic ? "claude-3-5-sonnet-20241022" : "gpt-4o");

    logger.info(`Direct API agent calling ${isAnthropic ? "Anthropic" : "OpenAI"} using model ${model}...`);

    try {
      let textResponse = "";
      let inputTokens = 0;
      let outputTokens = 0;

      if (isAnthropic) {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 4000,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`Anthropic API error (${res.status}): ${errText}`);
        }

        const data: any = await res.json();
        textResponse = data.content[0].text;
        inputTokens = data.usage?.input_tokens || Math.round(prompt.length / 4);
        outputTokens = data.usage?.output_tokens || Math.round(textResponse.length / 4);
      } else {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "authorization": `Bearer ${apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model,
            max_tokens: 4000,
            messages: [{ role: "user", content: prompt }],
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(`OpenAI API error (${res.status}): ${errText}`);
        }

        const data: any = await res.json();
        textResponse = data.choices[0].message.content;
        inputTokens = data.usage?.prompt_tokens || Math.round(prompt.length / 4);
        outputTokens = data.usage?.completion_tokens || Math.round(textResponse.length / 4);
      }

      const signal = this.parseSignal(textResponse);
      
      // Calculate cost estimate ($15/MTok input, $75/MTok output for Sonnet 3.5 roughly)
      const inputCost = (inputTokens / 1_000_000) * 3;
      const outputCost = (outputTokens / 1_000_000) * 15;

      return {
        signal,
        output: textResponse,
        exitCode: 0,
        usage: {
          inputTokens,
          outputTokens,
          estimatedCostUSD: parseFloat((inputCost + outputCost).toFixed(5)),
        },
      };
    } catch (err: any) {
      logger.error(`Direct API agent error: ${err.message}`);
      return {
        signal: "ERROR",
        output: `Direct API call failed: ${err.message}`,
        exitCode: -1,
      };
    }
  }

  private parseSignal(output: string): string {
    if (output.includes("SLICE_DONE")) return "SLICE_DONE";
    if (output.includes("BROWSER_TEST_PASS")) return "BROWSER_TEST_PASS";
    if (output.includes("REVIEW_PASS")) return "REVIEW_PASS";
    return "ERROR";
  }
}
