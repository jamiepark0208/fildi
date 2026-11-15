/**
 * Single Haiku call helper — usage logging + optional ai_usage_log row.
 * All product Haiku surfaces should go through here (or ai-explain.ts).
 */
import Anthropic from "@anthropic-ai/sdk";
import { logApiCall } from "./api-logger.js";
import { recordAiUsage } from "./ai-usage.js";

import LLM from "./llm-models.json" with { type: "json" };

const anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
/** E8 (10-30): ids + 'thinking off' form come from llm-models.json, shared with scripts/watchlist_sync/llm.py.
 *  Haiku 4.5 → 5.5: 10× cheaper ($0.10 / $0.50 per MTok); thinking off + effort low keeps the old no-thinking behaviour. */
export const HAIKU_MODEL: string = LLM.tiers.haiku;
const HAIKU_OFF = (LLM.models as Record<string, { thinking_off: { type: string } | null }>)[HAIKU_MODEL]?.thinking_off;

const CREDIT_BLOCK_TTL_MS = 6 * 3600_000;
let creditBlockedUntil = 0;
let creditBlockedKey = "";

export function isAnthropicBillingError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err ?? "");
  return /credit balance is too low|Plans & Billing|insufficient_quota|payment_required/i.test(msg);
}

export function isAnthropicCreditExhausted(): boolean {
  const curKey = process.env["ANTHROPIC_API_KEY"] ?? "";
  if (!curKey) return true;
  if (creditBlockedUntil > Date.now() && creditBlockedKey === curKey) return true;
  return false;
}

export function resetAnthropicCreditBlock(): void {
  creditBlockedUntil = 0;
  creditBlockedKey = "";
}

export interface HaikuCallOpts {
  prompt: string;
  maxTokens: number;
  /** api_usage / log trigger label */
  trigger: string;
  surfaceType: string;
  userId?: number;
  /** "_" for non-ticker surfaces */
  ticker?: string;
  /** Request deadline (rule 8c); SDK default is 10 min. */
  timeoutMs?: number;
}

export interface HaikuCallResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export async function callHaiku(opts: HaikuCallOpts): Promise<HaikuCallResult> {
  if (isAnthropicCreditExhausted()) {
    throw new Error("Anthropic credit balance is too low (circuit-breaker active; local fallback enabled)");
  }
  let msg: Anthropic.Message;
  try {
    msg = await anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: opts.maxTokens,
      messages: [{ role: "user", content: opts.prompt }],
      ...(HAIKU_OFF ? { thinking: HAIKU_OFF, output_config: { effort: "low" } } : {}),
    } as Anthropic.MessageCreateParamsNonStreaming, opts.timeoutMs ? { timeout: opts.timeoutMs, maxRetries: 1 } : undefined);
  } catch (err) {
    if (isAnthropicBillingError(err)) {
      creditBlockedUntil = Date.now() + CREDIT_BLOCK_TTL_MS;
      creditBlockedKey = process.env["ANTHROPIC_API_KEY"] ?? "";
    }
    // Failed calls still count toward the API Monitor and show up in api.log.
    logApiCall({
      source: "anthropic",
      fn: "messages.create",
      trigger: opts.trigger,
      ticker: opts.ticker,
      outcome: "failure",
      error: String((err as Error)?.message ?? err),
    });
    throw err;
  }
  const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  const inputTokens = msg.usage?.input_tokens ?? 0;
  const outputTokens = msg.usage?.output_tokens ?? 0;

  logApiCall({
    source: "anthropic",
    fn: "messages.create",
    trigger: opts.trigger,
    ticker: opts.ticker,
    outcome: "success",
    inputTokens,
    outputTokens,
  });

  // Every metered call lands in ai_usage_log (A130), user or system job — Settings › API Monitor › AI spend.
  recordAiUsage({
    userId: opts.userId ?? null,
    ticker: opts.ticker ?? "_",
    surfaceType: opts.surfaceType,
    cached: false,
    inputTokens,
    outputTokens,
    model: HAIKU_MODEL,
  });

  return { text, inputTokens, outputTokens };
}
