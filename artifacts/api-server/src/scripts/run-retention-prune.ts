/**
 * One-shot retention prune for Maintain LaunchAgent (runs even if API was down all day).
 * Usage: pnpm exec tsx src/scripts/run-retention-prune.ts
 *
 * Covers DB tables (api_usage, ai_usage_log, old intraday app_config keys) plus
 * filesystem logs (/tmp/api-server.log, logs/*.log, /tmp/fildi-logs).
 */
import { pool } from "@workspace/db";
import { pruneOldRows } from "../lib/retention.js";

const report = await pruneOldRows();
console.log(JSON.stringify({ ts: new Date().toISOString(), ...report }));
await pool.end().catch(() => {});
process.exit(report.ok ? 0 : 1);
