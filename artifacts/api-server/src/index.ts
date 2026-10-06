import { loadEnvLocal } from "./lib/load-env-local";
// Before any other module reads process.env (Schwab / DB / FactSet).
const envBoot = loadEnvLocal();

import app from "./app";
import { logger } from "./lib/logger";
import { runSeed } from "./lib/seeder";
import { withRetry } from "./lib/retry";
import { startScheduler } from "./lib/scheduler";
import { runStartupStaleRefresh } from "./lib/startup-refresh";
import { startCacheSweep } from "./lib/cache-registry";

if (envBoot.filled.length) {
  logger.info(
    { path: envBoot.path, filled: envBoot.filled },
    "boot: filled missing env from .env.local",
  );
}

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

// Last-resort process guards: an unhandled rejection crashes the process on modern
// Node, and an uncaught exception leaves it in an undefined state. Log both loudly so
// Sentry/logs capture the cause instead of a silent exit under long-running load.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException");
});

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startScheduler().catch((e: unknown) => logger.error({ err: e }, "startup: scheduler init failed"));
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

// Graceful shutdown: on redeploy/restart Replit sends SIGTERM. Stop accepting new
// connections and let in-flight requests drain (e.g. a mid-write enrichment) instead
// of being killed abruptly. Force-exit after a grace window so a hung socket can't
// block the restart forever.
let shuttingDown = false;
function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown: draining connections");
  const forceTimer = setTimeout(() => {
    logger.warn("shutdown: grace period elapsed, forcing exit");
    process.exit(0);
  }, 10_000);
  forceTimer.unref();
  server.close(() => {
    logger.info("shutdown: server closed cleanly");
    process.exit(0);
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
