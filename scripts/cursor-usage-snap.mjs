#!/usr/bin/env node
/**
 * Snap Cursor plan usage → ~/.fildi/cursor-limits.json (same role as claude-limits.json).
 * Auth: read-only Bearer from Cursor's local state.vscdb (never printed / never written here).
 * API: POST api2.cursor.sh/.../GetCurrentPeriodUsage (what OpenUsage / Headroom use).
 *
 * Run: node scripts/cursor-usage-snap.mjs
 * Safe to cron every 5–15 min; Agents overview also refreshes when the file is stale.
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = join(homedir(), ".fildi/cursor-limits.json");
const STATE = join(
  homedir(),
  "Library/Application Support/Cursor/User/globalStorage/state.vscdb",
);

function readKey(key) {
  const v = execFileSync(
    "sqlite3",
    [STATE, `SELECT value FROM ItemTable WHERE key = '${key.replace(/'/g, "''")}';`],
    { encoding: "utf8", maxBuffer: 4 << 20 },
  ).trim();
  return v || null;
}

function writeSnap(body) {
  mkdirSync(join(homedir(), ".fildi"), { recursive: true });
  writeFileSync(OUT, JSON.stringify(body, null, 0) + "\n", "utf8");
}

async function main() {
  const token = readKey("cursorAuth/accessToken");
  const plan = readKey("cursorAuth/stripeMembershipType") ?? "unknown";
  if (!token) {
    writeSnap({ at: new Date().toISOString(), error: "no_access_token", plan });
    process.exit(2);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1",
    Accept: "application/json",
  };

  let usage = null;
  let err = null;
  try {
    const r = await fetch(
      "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      { method: "POST", headers, body: "{}" },
    );
    if (!r.ok) {
      err = `usage_http_${r.status}`;
    } else {
      usage = await r.json();
    }
  } catch (e) {
    err = `usage_fetch:${e instanceof Error ? e.message : String(e)}`;
  }

  const pu = usage?.planUsage ?? usage?.plan_usage ?? {};
  const totalPct = num(pu.totalPercentUsed ?? pu.total_percent_used);
  const autoPct = num(pu.autoPercentUsed ?? pu.auto_percent_used);
  const apiPct = num(pu.apiPercentUsed ?? pu.api_percent_used);
  const cycleEnd = usage?.billingCycleEnd ?? usage?.billing_cycle_end ?? null;
  const snap = {
    at: new Date().toISOString(),
    plan,
    totalPercentUsed: totalPct,
    autoPercentUsed: autoPct,
    apiPercentUsed: apiPct,
    billingCycleEnd: cycleEnd,
    totalSpendCents: num(pu.totalSpend ?? pu.total_spend),
    includedSpendCents: num(pu.includedSpend ?? pu.included_spend),
    limitCents: num(pu.limit),
    error: err,
  };
  writeSnap(snap);
  // stdout: one-line summary only — never the bearer
  const left = totalPct == null ? "?" : Math.max(0, Math.round(100 - totalPct));
  console.log(`cursor-usage: ${left}% left · plan=${plan}${err ? ` · ${err}` : ""} → ${OUT}`);
  process.exit(err ? 1 : 0);
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

main();
