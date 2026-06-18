import app from "./app";
import { logger } from "./lib/logger";
import { runSeed } from "./lib/seeder";
import { WATCHLIST } from "./lib/constants";
import { getStaleTickers } from "./lib/fundamentals-db";
import { refreshFundamentals } from "./routes/fundamentals";
import { getStaleTechnicalTickers, refreshTechnicals } from "./lib/technicals-db";
import { withRetry } from "./lib/retry";

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

  withRetry(() => runSeed(), {
    onRetry: (attempt, err) => logger.warn({ err, attempt }, "startup: seed retry"),
  }).catch(e => logger.error({ err: e }, "startup: seed failed after retries"));

  withRetry(() =>
    getStaleTickers(WATCHLIST).then(stale => {
      if (stale.length === 0) return;
      logger.info({ count: stale.length }, "startup: refreshing stale FMP fundamentals");
      return refreshFundamentals(stale);
    }), {
    onRetry: (attempt, err) => logger.warn({ err, attempt }, "startup: fundamentals retry"),
  }).catch(e => logger.error({ err: e }, "startup: fundamentals failed after retries"));

  withRetry(() =>
    getStaleTechnicalTickers(WATCHLIST).then(stale => {
      if (stale.length === 0) return;
      logger.info({ count: stale.length }, "startup: refreshing stale technicals");
      return refreshTechnicals(stale);
    }), {
    onRetry: (attempt, err) => logger.warn({ err, attempt }, "startup: technicals retry"),
  }).catch(e => logger.error({ err: e }, "startup: technicals failed after retries"));
});
