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
  error?: string;
  requestedFields?: string;
  usageToday?: number;
  usageLimit?: number;
}

export function logApiCall(params: ApiCallParams): void {
  try {
    const msg = `api-call: ${params.source}.${params.fn} ${params.outcome}`;
    if (params.outcome === "success") {
      logger.info(params, msg);
    } else {
      logger.warn(params, msg);
    }
    // Fire-and-forget: persist call count to api_usage table for API Monitor.
    // Counts both successes and failures — both consume quota.
    recordApiUsage(params.source, 1).catch(() => {});
  } catch {
    // must never throw
  }
}
