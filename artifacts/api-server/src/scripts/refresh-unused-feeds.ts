/**
 * A267 one-shot. Model List + scanner pool by default; --scope=universe is the weekly pass.
 *   cd artifacts/api-server && npx tsx src/scripts/refresh-unused-feeds.ts
 * Polygon stays on polygon.gate (5/min, shared). Schwab calls land in api_usage.
 */
import { loadEnvLocal } from "../lib/load-env-local.js";

loadEnvLocal();

const scope = process.argv.includes("--scope=universe") ? "universe" : "pool";
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
const scanArg = process.argv.find((a) => a.startsWith("--scan="));
const scanN = scanArg ? Number(scanArg.split("=")[1]) : 3;

const { runUnusedFeeds, modelListPool } = await import("../lib/unused-feeds.js");
const { fetchChainsForTickers } = await import("../lib/options-chain-batch.js");
const { pool } = await import("@workspace/db");

const summary = await runUnusedFeeds({ scope, limit });
const names = (await modelListPool()).slice(0, Number.isFinite(scanN) && scanN > 0 ? scanN : 0);
if (names.length > 0) {
  const scanned = await fetchChainsForTickers(names, { logLabel: "option-score-snapshots", concurrency: 1 });
  console.log(JSON.stringify({ scanSample: names, chains: scanned.chainsByTicker.size, failures: scanned.failures }));
}
const usage = await pool.query(
  `SELECT source, calls_made FROM api_usage WHERE date = $1::date AND source IN ('schwab','polygon','polygon_429')`,
  [summary.today],
);
const cov = await pool.query(
  `SELECT feed, count(DISTINCT ticker)::int AS names, sum(rows)::int AS rows
   FROM feed_coverage WHERE as_of = $1::date GROUP BY feed ORDER BY feed`,
  [summary.today],
);
console.log(JSON.stringify({ summary, api_usage: usage.rows, coverage: cov.rows }, null, 2));
await pool.end();
