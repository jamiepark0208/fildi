import app from "./app";
import { logger } from "./lib/logger";
import { runSeed } from "./lib/seeder";
import { withRetry } from "./lib/retry";
import { startScheduler } from "./lib/scheduler";
import { runStartupStaleRefresh } from "./lib/startup-refresh";
import { startCacheSweep } from "./lib/cache-registry";

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
  startCacheSweep(); // bug/5: periodic prune of expired TTLCache entries

  withRetry(() => runSeed(), {
    onRetry: (attempt, err) => logger.warn({ err, attempt }, "startup: seed retry"),
  }).catch(e => logger.error({ err: e }, "startup: seed failed after retries"));

  // bug/4: capped, registry-scoped refresh — full-universe coverage stays
  // with the scheduler (lib/scheduler.ts), not process boot.
  runStartupStaleRefresh().catch((e: unknown) =>
    logger.error({ err: e }, "startup: stale refresh failed"),
  );
});
