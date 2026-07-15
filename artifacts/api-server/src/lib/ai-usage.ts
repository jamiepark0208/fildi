import { db, aiUsageLog } from "@workspace/db";
import { logger } from "./logger.js";

export interface AiUsageParams {
  userId: number;
  ticker: string;
  surfaceType: string;
  cached: boolean;
}

// Fire-and-forget per-user audit row. Metadata only — never persist prompt or
// explanation text here (see schema comment on ai_usage_log).
export function recordAiUsage(params: AiUsageParams): void {
  db.insert(aiUsageLog).values(params).catch(err => {
    logger.warn({ err, ...params }, "recordAiUsage: insert failed");
  });
}
