/**
 * Single Haiku call helper — usage logging + optional ai_usage_log row.
 * All product Haiku surfaces should go through here (or ai-explain.ts).
 */
import Anthropic from "@anthropic-ai/sdk";
import { logApiCall } from "./api-logger.js";
import { recordAiUsage } from "./ai-usage.js";

const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });

export interface HaikuCallOpts {
  prompt: string;
  maxTokens: number;
  /** api_usage / log trigger label */
  trigger: string;
  surfaceType: string;
  userId?: number;
  /** "_" for non-ticker surfaces */
  ticker?: string;
}

export interface HaikuCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function callHaiku(opts: HaikuCallOpts): Promise<HaikuCallResult> {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: opts.maxTokens,
    messages: [{ role: "user", content: opts.prompt }],
  });
  const text = msg.content[0]?.type === "text" ? msg.content[0].text.trim() : "";
  const inputTokens = msg.usage?.input_tokens ?? 0;
  const outputTokens = msg.usage?.output_tokens ?? 0;

  logApiCall({
    source: "anthropic",
    fn: "messages.create",
    trigger: opts.trigger,
    ticker: opts.ticker,
    outcome: "success",
    fieldsReturned: inputTokens + outputTokens,
  });

  if (opts.userId != null) {
    recordAiUsage({
      userId: opts.userId,
      ticker: opts.ticker ?? "_",
      surfaceType: opts.surfaceType,
      cached: false,
      inputTokens,
      outputTokens,
    });
  }

  return { text, inputTokens, outputTokens };
}
