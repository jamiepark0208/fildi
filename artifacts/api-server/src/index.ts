import { loadEnvLocal } from "./lib/load-env-local";
// Before any other module reads process.env (Schwab / DB / FactSet).
const envBoot = loadEnvLocal();

import * as Sentry from "@sentry/node";
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
// block the restart forever. Crash paths use the same drain with a non-zero exit.
let shuttingDown = false;
function shutdown(signal: string, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal, exitCode }, "shutdown: draining connections");
  const forceTimer = setTimeout(() => {
    logger.warn({ exitCode }, "shutdown: grace period elapsed, forcing exit");
    process.exit(exitCode);
  }, 10_000);
  forceTimer.unref();

  const finish = () => {
    // Flush Sentry so the crash/exception that triggered shutdown is delivered.
    void Sentry.close(2000)
      .catch(() => undefined)
      .finally(() => {
        logger.info({ exitCode }, "shutdown: server closed cleanly");
        process.exit(exitCode);
      });
  };

  server.close(() => finish());
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));

// Last-resort process guards: an unhandled rejection crashes the process on modern
// Node, and an uncaught exception leaves it in an undefined state. Log structurally,
// then drain the HTTP server / Sentry and exit non-zero so the process manager restarts
// a clean process (and the in-process scheduler) rather than limping on.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandledRejection");
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaughtException");
  shutdown("uncaughtException", 1);
});
