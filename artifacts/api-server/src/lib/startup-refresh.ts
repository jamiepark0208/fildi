import { eq, and } from "drizzle-orm";
import { db, tickerRegistry } from "@workspace/db";
import { logger } from "./logger";
import { WATCHLIST } from "./constants";
import { getStaleTickers, checkFMPBudget } from "./fundamentals-db";
import { refreshFundamentals } from "../routes/fundamentals";
import { getStaleTechnicalTickers, refreshTechnicals } from "./technicals-db";
import { withRetry } from "./retry";

// bug/4: booting used to refresh the entire fmp_fundamentals table (~257
// tickers) on every process start, so a redeploy/crash loop repeatedly burned
// FMP/Yahoo budget. Startup should only warm a small, capped slice of the
// registry — the scheduler (lib/scheduler.ts) still handles full coverage.
const DEFAULT_CAP = 25;

function getStartupCap(): number {
  const raw = process.env["STARTUP_REFRESH_CAP"];
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CAP;
}

async function resolveStartupUniverse(): Promise<string[]> {
  const rows = await db
    .select({ ticker: tickerRegistry.ticker })
    .from(tickerRegistry)
    .where(and(eq(tickerRegistry.fetchFundamentals, true), eq(tickerRegistry.isActive, true)));

  if (rows.length > 0) return rows.map(r => r.ticker);

  // Empty registry (fresh DB before seeder/watchlist activity) — fall back to
  // the core constant list so a cold boot still has something to warm.
  return WATCHLIST;
}

export async function runStartupStaleRefresh(): Promise<void> {
  if (process.env["SKIP_STARTUP_REFRESH"] === "true") {
    logger.info("startup: SKIP_STARTUP_REFRESH=true — skipping startup refresh");
    return;
  }

  const cap = getStartupCap();
  const universe = await resolveStartupUniverse();
  logger.info({ count: universe.length, cap }, "startup: resolved refresh universe");

  await withRetry(() =>
    getStaleTickers(universe).then(async stale => {
      if (stale.length === 0) return;
      const capped = stale.slice(0, cap);

      let budget;
      try {
        budget = await checkFMPBudget(capped.length * 7);
      } catch (err) {
        logger.warn({ err }, "startup: FMP budget check failed — skipping stale refresh");
        return;
      }
      if (!budget.allowed) {
        logger.warn(
          { callsNeeded: capped.length * 7, callsToday: budget.callsToday, remaining: budget.remaining },
          "startup: FMP budget exhausted — skipping stale refresh",
        );
        return;
      }
      logger.info({ count: capped.length, staleTotal: stale.length, cap }, "startup: refreshing stale FMP fundamentals");
      return refreshFundamentals(capped);
    }), {
    onRetry: (attempt, err) => logger.warn({ err, attempt }, "startup: fundamentals retry"),
  }).catch(e => logger.error({ err: e }, "startup: fundamentals failed after retries"));

  await withRetry(() =>
    getStaleTechnicalTickers(universe).then(stale => {
      if (stale.length === 0) return;
      const capped = stale.slice(0, cap);
      logger.info({ count: capped.length, staleTotal: stale.length, cap }, "startup: refreshing stale technicals");
      return refreshTechnicals(capped);
    }), {
    onRetry: (attempt, err) => logger.warn({ err, attempt }, "startup: technicals retry"),
  }).catch(e => logger.error({ err: e }, "startup: technicals failed after retries"));
}
