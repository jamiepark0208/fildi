#!/usr/bin/env node
/**
 * Schwab re-auth watchdog (LaunchAgent com.fildi.schwab-auth-watch, hourly).
 *
 * Schwab refresh tokens hard-expire 7 days after login; only a browser login renews them.
 * When < WINDOW_H hours remain (or the token is expired/invalid), during waking hours:
 *   macOS notification → runs scripts/schwab-oauth.mjs (opens Chrome to the Schwab login,
 *   waits up to 20 min for the callback). Retries every RETRY_H hours until it succeeds.
 *
 *   node scripts/schwab-auth-watch.mjs            # normal (LaunchAgent)
 *   node scripts/schwab-auth-watch.mjs --status   # print hours left, do nothing
 *   node scripts/schwab-auth-watch.mjs --force    # prompt now regardless of window
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN_PATH = join(homedir(), ".tradedash", "schwab-tokens.json");
const STATE_PATH = join(homedir(), ".tradedash", "schwab-reauth-watch.json");
const WINDOW_H = 36;
const RETRY_H = 3;
const WAKE_HOURS = [8, 22]; // local time; never pop a login at night
const REFRESH_LIFE_MS = 7 * 24 * 3600 * 1000;

const args = new Set(process.argv.slice(2));
const now = Date.now();

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function notify(title, msg) {
  try {
    execFileSync("osascript", [
      "-e",
      `display notification ${JSON.stringify(msg)} with title ${JSON.stringify(title)} sound name "Glass"`,
    ]);
  } catch {
    /* notification is best-effort */
  }
}

const tok = readJson(TOKEN_PATH);
const obtained = tok?.obtainedAt ? Date.parse(tok.obtainedAt) : NaN;
const hoursLeft = Number.isFinite(obtained) ? (obtained + REFRESH_LIFE_MS - now) / 3600e3 : -1;
const invalid = !tok?.refresh_token || /invalid_grant|unauthorized/i.test(String(tok?.lastError ?? ""));
const needs = invalid || hoursLeft < WINDOW_H;

console.log(
  `${new Date(now).toISOString()} schwab refresh: ${hoursLeft.toFixed(1)} h left` +
    (invalid ? " (invalid)" : "") + (needs ? " → needs re-auth" : " → ok"),
);
if (args.has("--status")) process.exit(0);
if (!needs && !args.has("--force")) process.exit(0);

const hour = new Date(now).getHours();
const state = readJson(STATE_PATH) ?? {};
const sinceTry = state.lastAttemptAt ? (now - Date.parse(state.lastAttemptAt)) / 3600e3 : Infinity;
if (!args.has("--force")) {
  if (hour < WAKE_HOURS[0] || hour >= WAKE_HOURS[1]) process.exit(0);
  if (sinceTry < RETRY_H) process.exit(0);
}

// Another login (manual run or another agent) already owns the callback port → don't fight it.
const busy = spawnSync("lsof", ["-nP", "-iTCP:8182", "-sTCP:LISTEN"], { encoding: "utf8" }).stdout?.trim();
if (busy) {
  console.log("callback port 8182 busy — another Schwab login is in progress; skipping");
  process.exit(0);
}

writeFileSync(STATE_PATH, JSON.stringify({ ...state, lastAttemptAt: new Date(now).toISOString() }, null, 2));
const left = hoursLeft > 0 ? `${Math.round(hoursLeft)} h left` : "expired";
notify("Schwab login needed", `Refresh token ${left}. Chrome is opening the Schwab login — sign in + Allow.`);

const env = { ...process.env, SCHWAB_OAUTH_TIMEOUT_MS: String(20 * 60_000) };
const r = spawnSync(process.execPath, ["--env-file=.env.local", "scripts/schwab-oauth.mjs"], {
  cwd: ROOT,
  env,
  stdio: "inherit",
});

const after = readJson(TOKEN_PATH);
const ok = r.status === 0 && after?.obtainedAt && Date.parse(after.obtainedAt) > (obtained || 0);
writeFileSync(
  STATE_PATH,
  JSON.stringify(
    { lastAttemptAt: new Date(now).toISOString(), lastResult: ok ? "ok" : `fail (exit ${r.status ?? r.signal})`, lastOkAt: ok ? new Date().toISOString() : state.lastOkAt ?? null },
    null,
    2,
  ),
);
notify(
  ok ? "Schwab re-auth done" : "Schwab re-auth not finished",
  ok ? "New 7-day token saved. Model List verify will use it." : `Will retry in ${RETRY_H} h (8 AM–10 PM).`,
);
process.exit(ok ? 0 : 1);
