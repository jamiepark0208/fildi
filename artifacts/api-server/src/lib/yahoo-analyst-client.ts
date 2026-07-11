import YahooFinanceClass from "yahoo-finance2";
import { logApiCall } from "./api-logger.js";

const yahooFinance = new YahooFinanceClass();

/** Raw Yahoo upgradeDowngradeHistory items — unparsed, caller dedups/maps via parseAnalystHistory. */
export async function fetchYahooAnalystActions(ticker: string): Promise<unknown[]> {
  const symbol = ticker.toUpperCase().replace(".", "-");

  try {
    const raw = await yahooFinance.quoteSummary(symbol, {
      modules: ["upgradeDowngradeHistory"],
    }, { validateResult: false });
    const history = (raw as any).upgradeDowngradeHistory?.history ?? [];
    logApiCall({ source: "yahoo", fn: "fetchYahooAnalystActions", trigger: "backfill-analyst-events script", ticker, outcome: "success", fieldsReturned: history.length });
    return history;
  } catch (err: any) {
    logApiCall({ source: "yahoo", fn: "fetchYahooAnalystActions", trigger: "backfill-analyst-events script", ticker, outcome: "failure", error: err.message, requestedFields: "quoteSummary: upgradeDowngradeHistory" });
    return [];
  }
}
