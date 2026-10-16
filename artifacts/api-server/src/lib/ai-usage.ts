import { sql } from "drizzle-orm";
import { db, aiUsageLog } from "@workspace/db";
import { summarizeAiSpend, type AiSpendSummary } from "./ai-pricing.js";
import { logger } from "./logger.js";

export interface AiUsageParams {
  /** null/undefined = system job (A130: every metered call is logged) */
  userId?: number | null;
  ticker: string;
  surfaceType: string;
  cached: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
  model?: string | null;
}

// Fire-and-forget audit row (per user, or system job when userId is null). Metadata only — never persist prompt or
// explanation text here (see schema comment on ai_usage_log).
export function recordAiUsage(params: AiUsageParams): void {
  db.insert(aiUsageLog).values({
    userId: params.userId ?? null,
    ticker: params.ticker,
    surfaceType: params.surfaceType,
    cached: params.cached,
    inputTokens: params.inputTokens ?? null,
    outputTokens: params.outputTokens ?? null,
    model: params.model ?? null,
  }).catch(err => {
    logger.warn({ err, userId: params.userId, surfaceType: params.surfaceType }, "recordAiUsage: insert failed");
  });
}

// ── AI spend (A130): month-to-date metered calls → est $ (Settings › API Monitor) ──
/** Real (uncached) calls since the 1st of this month, grouped by surface + model. */
export async function getAiSpendThisMonth(): Promise<AiSpendSummary> {
  const r = await db.execute<{ surface_type: string; model: string | null; calls: number; in_tok: string; out_tok: string; since: string }>(sql`
    SELECT surface_type, model, count(*)::int AS calls,
           coalesce(sum(input_tokens), 0)::bigint AS in_tok, coalesce(sum(output_tokens), 0)::bigint AS out_tok,
           to_char(date_trunc('month', now()), 'YYYY-MM-DD') AS since
    FROM ai_usage_log
    WHERE cached = false AND created_at >= date_trunc('month', now())
    GROUP BY surface_type, model`);
  const rows = r.rows;
  const since = rows[0]?.since ?? new Date().toISOString().slice(0, 8) + "01";
  return summarizeAiSpend(rows.map(x => ({ surfaceType: x.surface_type, model: x.model, calls: Number(x.calls),
    inputTokens: Number(x.in_tok), outputTokens: Number(x.out_tok) })), since);
}
