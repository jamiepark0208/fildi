/**
 * One-shot retention prune for Maintain LaunchAgent (runs even if API was down all day).
 * Usage: pnpm exec tsx src/scripts/run-retention-prune.ts
 *
 * Covers DB tables (api_usage, ai_usage_log, old intraday app_config keys) plus
 * filesystem logs (/tmp/api-server.log, logs/*.log, /tmp/fildi-logs).
 */
import { pool } from "@workspace/db";
import { pruneOldRows } from "../lib/retention.js";
import { etDateKey } from "../lib/market-hours.js";

// Stamps last_retention_prune (same key as the API's job, which now defers to this one) and skips if done today (ET).
const { rows } = await pool.query("SELECT value FROM app_config WHERE key = 'last_retention_prune'");
const last = rows[0]?.value ? new Date(rows[0].value) : null;
if (!process.argv.includes("--force") && last && !Number.isNaN(last.getTime()) && etDateKey(last) === etDateKey()) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), skipped: "already pruned today (ET)", last: rows[0].value }));
  await pool.end().catch(() => {});
  process.exit(0);
}
const report = await pruneOldRows();
if (report.ok) {
  await pool.query(
    "INSERT INTO app_config (key, value, updated_at) VALUES ('last_retention_prune', $1, now()) " +
      "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    [new Date().toISOString()],
  );
}
console.log(JSON.stringify({ ts: new Date().toISOString(), ...report }));
await pool.end().catch(() => {});
process.exit(report.ok ? 0 : 1);
