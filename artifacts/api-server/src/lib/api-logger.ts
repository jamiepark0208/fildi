import { logger } from "./logger.js";

export type ApiSource = "fmp" | "polygon" | "av" | "finnhub" | "yahoo" | "edgar" | "fred" | "cnn" | "nyfed";

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
  } catch {
    // must never throw — logging is never allowed to break the caller
  }
}
