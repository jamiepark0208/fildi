import app from "./app";
import { logger } from "./lib/logger";
import { runSeed } from "./lib/seeder";
import { WATCHLIST } from "./lib/constants";
import { getStaleTickers } from "./lib/fundamentals-db";
import { refreshFundamentals } from "./routes/fundamentals";

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

  // Fire-and-forget: pre-populate indicator_cache for all tickers missing today's data.
  runSeed().catch(e => logger.error({ err: e }, "seed crashed"));

  // Fire-and-forget: refresh FMP fundamentals for any ticker whose data is >7 days old.
  getStaleTickers(WATCHLIST)
    .then(stale => {
      if (stale.length === 0) return;
      logger.info({ count: stale.length }, "startup: refreshing stale FMP fundamentals");
      return refreshFundamentals(stale);
    })
    .catch(e => logger.error({ err: e }, "startup: fundamentals stale check crashed"));
});
