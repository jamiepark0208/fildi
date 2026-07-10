import app from "./app";
import { logger } from "./lib/logger";
import { runSeed } from "./lib/seeder";
import { getStaleTickers, checkFMPBudget } from "./lib/fundamentals-db";
import { refreshFundamentals } from "./routes/fundamentals";
import { getStaleTechnicalTickers, refreshTechnicals } from "./lib/technicals-db";
import { withRetry } from "./lib/retry";
import { startScheduler } from "./lib/scheduler";
import { db, fmpFundamentals } from "@workspace/db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startScheduler();

  withRetry(() => runSeed(), {
    onRetry: (attempt, err) => logger.warn({ err, attempt }, "startup: seed retry"),
  }).catch(e => logger.error({ err: e }, "startup: seed failed after retries"));

  // Resolve the full FMP universe once; use it for both fundamentals and technicals.
  db.select({ ticker: fmpFundamentals.ticker }).from(fmpFundamentals).then(async (rows: Array<{ ticker: string }>) => {
    const fmpUniverse = rows.map((r: { ticker: string }) => r.ticker);
    logger.info({ count: fmpUniverse.length }, "startup: resolved FMP universe");

    withRetry(() =>
      getStaleTickers(fmpUniverse).then(async stale => {
        if (stale.length === 0) return;
        let budget;
        try {
          budget = await checkFMPBudget(stale.length * 7);
        } catch (err) {
          logger.warn({ err }, "startup: FMP budget check failed — skipping stale refresh");
          return;
        }
        if (!budget.allowed) {
          logger.warn(
            { callsNeeded: stale.length * 7, callsToday: budget.callsToday, remaining: budget.remaining },
            "startup: FMP budget exhausted — skipping stale refresh",
          );
          return;
        }
        logger.info({ count: stale.length }, "startup: refreshing stale FMP fundamentals");
        return refreshFundamentals(stale);
      }), {
      onRetry: (attempt, err) => logger.warn({ err, attempt }, "startup: fundamentals retry"),
    }).catch(e => logger.error({ err: e }, "startup: fundamentals failed after retries"));

    // Technicals: full FMP universe so Stock DB technicals tab fills in over time.
    // Each new ticker bootstraps 420d OHLCV from Yahoo on first run (batched 3 at a time).
    withRetry(() =>
      getStaleTechnicalTickers(fmpUniverse).then(stale => {
        if (stale.length === 0) return;
        logger.info({ count: stale.length }, "startup: refreshing stale technicals");
        return refreshTechnicals(stale);
      }), {
      onRetry: (attempt, err) => logger.warn({ err, attempt }, "startup: technicals retry"),
    }).catch(e => logger.error({ err: e }, "startup: technicals failed after retries"));

  }).catch((e: unknown) => logger.error({ err: e }, "startup: failed to resolve FMP universe"));
});
