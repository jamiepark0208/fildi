import { logger } from "./logger.js";
import { recordApiUsage } from "./api-usage.js";

export type ApiSource =
  | "fmp"
  | "polygon"
  | "av"
  | "finnhub"
  | "yahoo"
  | "edgar"
  | "fred"
  | "cnn"
  | "nyfed"
  | "anthropic"
  | "factset";

export interface ApiCallParams {
  source: ApiSource;
  fn: string;
  trigger: string;
  ticker?: string;
  outcome: "success" | "failure";
  fieldsReturned?: number;
  /** LLM sources only — token usage for the log line (per-user rows live in ai_usage_log). */
  inputTokens?: number;
  outputTokens?: number;
  error?: string;
  requestedFields?: string;
  usageToday?: number;
  usageLimit?: number;
  /** Quota units consumed (default 1). FMP fundamentals = ~9 stable endpoints. */
  calls?: number;
}

export function logApiCall(params: ApiCallParams): void {
  try {
    const calls = params.calls != null && Number.isFinite(params.calls) ? Math.max(0, params.calls) : 1;
    const msg = `api-call: ${params.source}.${params.fn} ${params.outcome}`;
    if (params.outcome === "success") {
      logger.info(params, msg);
    } else {
      logger.warn(params, msg);
    }
    // Single SoT for Settings → API Monitor. Callers must NOT also recordApiUsage
    // for the same HTTP work (that double-counted FMP/Yahoo/etc.).
    if (calls > 0) {
      recordApiUsage(params.source, calls).catch(() => {});
    }
  } catch {
    // must never throw
  }
}
