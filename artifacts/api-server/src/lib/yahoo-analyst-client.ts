import { yahooFinance } from "./yahoo-client.js";
import { logApiCall } from "./api-logger.js";


/** Raw Yahoo upgradeDowngradeHistory items — unparsed; caller maps via parseAnalystHistory (UI groups by firm). */
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
