#!/usr/bin/env node
/**
 * TradeDash connection health monitor.
 *
 * Checks local stack + vendor APIs. Never prints secret values.
 *
 * Usage:
 *   node scripts/health-check.mjs           # once, exit 0/1
 *   node scripts/health-check.mjs --watch   # every 60s (or HEALTH_INTERVAL_SECS)
 *   node scripts/health-check.mjs --json    # machine-readable
 *
 * Loads repo-root .env.local if present.
 */
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { spawnSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = "/tmp/fildi-logs";
const LOG_FILE = `${LOG_DIR}/health-check.log`;
const WATCH = process.argv.includes("--watch");
const AS_JSON = process.argv.includes("--json");
const INTERVAL_MS = Number(process.env.HEALTH_INTERVAL_SECS || 60) * 1000;

function loadEnvLocal() {
  const path = resolve(ROOT, ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    let [k, ...rest] = line.split("=");
    k = k.trim();
    if (k.startsWith("export ")) k = k.slice(7).trim();
    let v = rest.join("=").trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

async function httpCheck(name, url, { headers = {}, expectOk = true, timeoutMs = 10000 } = {}) {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { headers, signal: ctrl.signal });
    clearTimeout(t);
    const ms = Date.now() - started;
    const ok = expectOk ? res.status >= 200 && res.status < 400 : true;
    return { name, ok, status: res.status, ms, detail: ok ? "ok" : `HTTP ${res.status}` };
  } catch (e) {
    return { name, ok: false, status: 0, ms: Date.now() - started, detail: String(e.message || e).slice(0, 120) };
  }
}

function tcpCheck(name, host, port, timeoutMs = 3000) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const socket = createConnection({ host, port }, () => {
      socket.end();
      resolvePromise({ name, ok: true, status: 1, ms: Date.now() - started, detail: "accepting" });
    });
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      socket.destroy();
      resolvePromise({ name, ok: false, status: 0, ms: Date.now() - started, detail: "timeout" });
    });
    socket.on("error", (e) => {
      resolvePromise({ name, ok: false, status: 0, ms: Date.now() - started, detail: String(e.message).slice(0, 80) });
    });
  });
}

function pgReadyCheck() {
  const bin =
    `${process.env.HOME}/Applications/Postgres.app/Contents/Versions/16/bin/pg_isready`;
  if (!existsSync(bin)) {
    return tcpCheck("postgres", "127.0.0.1", 5432);
  }
  const started = Date.now();
  const r = spawnSync(bin, ["-h", "127.0.0.1", "-p", "5432"], { encoding: "utf8" });
  return {
    name: "postgres",
    ok: r.status === 0,
    status: r.status ?? 1,
    ms: Date.now() - started,
    detail: (r.stdout || r.stderr || "").trim().slice(0, 80) || (r.status === 0 ? "ready" : "not ready"),
  };
}

async function runOnce() {
  loadEnvLocal();
  const results = [];

  results.push(await httpCheck("api_healthz", "http://127.0.0.1:8080/api/healthz"));
  results.push(await httpCheck("vite", "http://127.0.0.1:8081/"));
  results.push(await pgReadyCheck());

  const proxy = (process.env.FACTSET_PROXY_URL || "").replace(/\/$/, "");
  const proxySecret = process.env.FACTSET_PROXY_SECRET || "";
  if (proxy) {
    results.push(await httpCheck("factset_proxy_health", `${proxy}/health`));
    if (proxySecret) {
      results.push(
        await httpCheck(
          "factset_proxy_aapl",
          `${proxy}/factset/report/overview/v1/financial-highlights?id=AAPL-US`,
          { headers: { "x-proxy-secret": proxySecret, Accept: "application/json" }, timeoutMs: 25000 },
        ),
      );
    } else {
      results.push({ name: "factset_proxy_aapl", ok: false, status: 0, ms: 0, detail: "FACTSET_PROXY_SECRET missing" });
    }
  } else {
    results.push({ name: "factset_proxy_health", ok: false, status: 0, ms: 0, detail: "FACTSET_PROXY_URL missing" });
  }

  if (process.env.FINNHUB_API_KEY) {
    results.push(
      await httpCheck(
        "finnhub",
        `https://finnhub.io/api/v1/quote?symbol=AAPL&token=${process.env.FINNHUB_API_KEY}`,
      ),
    );
  } else {
    results.push({ name: "finnhub", ok: false, status: 0, ms: 0, detail: "FINNHUB_API_KEY missing" });
  }

  if (process.env.FMP_API_KEY) {
    results.push(
      await httpCheck(
        "fmp",
        `https://financialmodelingprep.com/stable/quote?symbol=AAPL&apikey=${process.env.FMP_API_KEY}`,
      ),
    );
  } else {
    results.push({ name: "fmp", ok: false, status: 0, ms: 0, detail: "FMP_API_KEY missing" });
  }

  if (process.env.POLYGON_API_KEY) {
    results.push(
      await httpCheck(
        "polygon",
        `https://api.polygon.io/v2/aggs/ticker/AAPL/prev?adjusted=true&apiKey=${process.env.POLYGON_API_KEY}`,
      ),
    );
  } else {
    results.push({ name: "polygon", ok: false, status: 0, ms: 0, detail: "POLYGON_API_KEY missing" });
  }

  if (process.env.ALPHA_VANTAGE_API_KEY) {
    results.push(
      await httpCheck(
        "alpha_vantage",
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=${process.env.ALPHA_VANTAGE_API_KEY}`,
        { timeoutMs: 15000 },
      ),
    );
  } else {
    results.push({ name: "alpha_vantage", ok: false, status: 0, ms: 0, detail: "ALPHA_VANTAGE_API_KEY missing" });
  }

  const ts = new Date().toISOString();
  const failed = results.filter((r) => !r.ok);
  const PROCESS = new Set(["api_healthz", "vite", "postgres"]);
  const processFailed = failed.filter((r) => PROCESS.has(r.name)).map((r) => r.name);
  const vendorFailed = failed.filter((r) => !PROCESS.has(r.name)).map((r) => r.name);
  const summary = {
    ts,
    ok: failed.length === 0,
    /** Local stack only — use this for LaunchAgent exit / UI "Failed" */
    processOk: processFailed.length === 0,
    vendorsOk: vendorFailed.length === 0,
    processFailed,
    vendorFailed,
    pass: results.filter((r) => r.ok).length,
    fail: failed.length,
    results,
  };

  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(LOG_FILE, JSON.stringify(summary) + "\n");

  if (AS_JSON) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`[health] ${ts}  ${summary.pass} pass / ${summary.fail} fail`);
    for (const r of results) {
      const mark = r.ok ? "OK  " : "FAIL";
      console.log(`  ${mark}  ${r.name.padEnd(22)} ${String(r.status).padStart(3)}  ${r.ms}ms  ${r.detail}`);
    }
    if (failed.length) console.log(`\nLog: ${LOG_FILE}`);
  }

  return summary.ok;
}

loadEnvLocal();
if (WATCH) {
  console.log(`[health] watching every ${INTERVAL_MS / 1000}s → ${LOG_FILE}`);
  const tick = async () => {
    try {
      await runOnce();
    } catch (e) {
      console.error("[health] tick error", e);
    }
  };
  await tick();
  setInterval(tick, INTERVAL_MS);
} else {
  const ok = await runOnce();
  process.exit(ok ? 0 : 1);
}
