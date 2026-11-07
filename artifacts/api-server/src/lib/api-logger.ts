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
  | "factset"
  | "lse";

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

/** In-memory per-source stats since server start (Agents › Stage › APIs drill, J4): errors today, last error, callers. */
type SourceStats = { day: string; errors: number; lastError: string | null; lastErrorAt: string | null; triggers: Record<string, number> };
const sourceStats = new Map<string, SourceStats>();
export function getApiSourceStats(): Record<string, SourceStats> {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  return Object.fromEntries([...sourceStats].filter(([, v]) => v.day === day));
}
function trackSource(p: ApiCallParams): void {
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  let s = sourceStats.get(p.source);
  if (!s || s.day !== day) sourceStats.set(p.source, (s = { day, errors: 0, lastError: s?.lastError ?? null, lastErrorAt: s?.lastErrorAt ?? null, triggers: {} }));
  s.triggers[p.trigger] = (s.triggers[p.trigger] ?? 0) + 1;
  if (p.outcome === "failure") { s.errors++; s.lastError = (p.error ?? p.fn).slice(0, 160); s.lastErrorAt = new Date().toISOString(); }
}

export function logApiCall(params: ApiCallParams): void {
  try {
    trackSource(params);
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
