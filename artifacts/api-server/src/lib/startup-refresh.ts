import { eq, and } from "drizzle-orm";
import { db, tickerRegistry } from "@workspace/db";
import { logger } from "./logger";
import { WATCHLIST } from "./constants";
import { getStaleTickers } from "./fundamentals-db";
import { enrichAndMergeTickers } from "./enrich-and-merge";
import { computeAndPersistFundamentalScores } from "./fundamentals-db";
import { getLatestRegime } from "../routes/regime";
import { getStaleTechnicalTickers, refreshTechnicals } from "./technicals-db";
import { withRetry } from "./retry";

// bug/4: booting used to refresh the entire fmp_fundamentals table (~257
// tickers) on every process start, so a redeploy/crash loop repeatedly burned
// FMP/Yahoo budget. Startup should only warm a small, capped slice of the
// registry — the scheduler (lib/scheduler.ts) still handles full coverage.
const DEFAULT_CAP = 25;

/** Cheap free sources only at boot — scarce FMP/AV left to nightly cohort. */
const STARTUP_SOURCES = ["yahoo", "edgar", "finnhub", "polygon"] as const;

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

      logger.info(
        { count: capped.length, staleTotal: stale.length, cap, sources: STARTUP_SOURCES },
        "startup: enrich+merge stale fundamentals (cheap sources)",
      );
      const result = await enrichAndMergeTickers([...capped], {
        sources: [...STARTUP_SOURCES],
      });
      if (!result.ok) {
        logger.warn({ reason: result.reason }, "startup: enrich+merge incomplete");
      }
      try {
        const regime = await getLatestRegime();
        await computeAndPersistFundamentalScores(regime);
      } catch (err) {
        logger.warn({ err: String(err) }, "startup: score recompute failed");
      }
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
