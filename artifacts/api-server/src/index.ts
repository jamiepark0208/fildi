import app from "./app";
import { logger } from "./lib/logger";
import { runSeed } from "./lib/seeder";

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
  // This runs in the background so the server starts instantly.
  runSeed().catch(e => logger.error({ err: e }, "seed crashed"));
});
