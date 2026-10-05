import { db, aiUsageLog } from "@workspace/db";
import { logger } from "./logger.js";

export interface AiUsageParams {
  userId: number;
  ticker: string;
  surfaceType: string;
  cached: boolean;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

// Fire-and-forget per-user audit row. Metadata only — never persist prompt or
// explanation text here (see schema comment on ai_usage_log).
export function recordAiUsage(params: AiUsageParams): void {
  db.insert(aiUsageLog).values({
    userId: params.userId,
    ticker: params.ticker,
    surfaceType: params.surfaceType,
    cached: params.cached,
    inputTokens: params.inputTokens ?? null,
    outputTokens: params.outputTokens ?? null,
  }).catch(err => {
    logger.warn({ err, userId: params.userId, surfaceType: params.surfaceType }, "recordAiUsage: insert failed");
  });
}
