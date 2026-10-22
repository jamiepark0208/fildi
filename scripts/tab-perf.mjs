#!/usr/bin/env node
/**
 * Tab performance probe — re-run anytime Jamie asks "why is X slow?".
 *
 *   node scripts/tab-perf.mjs              # default BASE http://127.0.0.1:8080
 *   BASE=http://127.0.0.1:8080 COOKIE='connect.sid=…' node scripts/tab-perf.mjs
 *
 * Exit 1 if any critical route is slower than its budget (or non-2xx/401/403).
 */
import { performance } from "node:perf_hooks";

const BASE = (process.env.BASE ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const COOKIE = process.env.COOKIE ?? "";
const TIMEOUT_MS = Number(process.env.TAB_PERF_TIMEOUT_MS ?? 90_000);

/** @type {{ tab: string; path: string; budgetS: number; critical?: boolean; authOk?: boolean }[]} */
const ROUTES = [
  { tab: "healthz", path: "/api/healthz", budgetS: 0.5, critical: true },
  // Rankings › Fundamentals — cache hit should be ≪1s / no metricScores (~300KB).
  // Recompute path is ~1s + 1.5MB (metricScores) — mark SLOW above budget.
  { tab: "rankings/fund", path: "/api/fundamentals/rankings", budgetS: 1.2, critical: true },
  { tab: "rankings/fund-slim", path: "/api/fundamentals/rankings?slim=1", budgetS: 0.8, critical: true },
  { tab: "rankings/tech", path: "/api/technicals/all", budgetS: 2.5, authOk: true },
  { tab: "rankings/quotes-sample", path: "/api/stocks/quotes?tickers=AAPL,MSFT,NVDA,SCHD", budgetS: 8.0, critical: true },
  // Watchlist
  { tab: "watchlist", path: "/api/watchlist", budgetS: 1.0, authOk: true },
  { tab: "watchlist/meta", path: "/api/watchlist/meta?lite=1", budgetS: 1.5, authOk: true },
  { tab: "watchlist/live", path: "/api/live/prices?tickers=AAPL,SCHD,SPY,NVDA", budgetS: 2.0, authOk: true },
  // Breakdown
  { tab: "breakdown/SCHD", path: "/api/stocks/breakdown?ticker=SCHD", budgetS: 8.0, critical: true },
  { tab: "breakdown/hist", path: "/api/stocks/history?ticker=SCHD&period=1Y", budgetS: 4.0, critical: true },
  // Live
  { tab: "live/hotlist", path: "/api/live/hotlist", budgetS: 3.0, authOk: true },
  { tab: "live/regime", path: "/api/live/regime", budgetS: 2.0, authOk: true },
  // Track record (paths vary — soft)
  { tab: "track-record", path: "/api/track-record", budgetS: 4.0, authOk: true },
  { tab: "track-record/stats", path: "/api/track-record/stats", budgetS: 4.0, authOk: true },
];

async function probe(path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: COOKIE ? { cookie: COOKIE } : {},
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ms = performance.now() - t0;
    return { ok: true, status: res.status, ms, bytes: buf.length };
  } catch (err) {
    const ms = performance.now() - t0;
    return { ok: false, status: 0, ms, bytes: 0, err: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

function fmt(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}MB`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}KB`;
  return `${n}B`;
}

const rows = [];
for (const r of ROUTES) {
  const p = await probe(r.path);
  const sec = p.ms / 1000;
  const authSoft = r.authOk && (p.status === 401 || p.status === 403);
  const slow = p.ok && !authSoft && p.status >= 200 && p.status < 300 && sec > r.budgetS;
  const fail = !p.ok || (p.status >= 500) || (r.critical && p.status === 404);
  const verdict = fail ? "FAIL" : authSoft ? "AUTH" : slow ? "SLOW" : "ok";
  rows.push({ ...r, ...p, sec, verdict });
}

console.log(`tab-perf  BASE=${BASE}  cookie=${COOKIE ? "yes" : "no"}`);
console.log(
  "verdict".padEnd(7),
  "tab".padEnd(22),
  "t".padStart(7),
  "budget".padStart(7),
  "bytes".padStart(9),
  "http".padStart(5),
  "path",
);
for (const r of rows) {
  console.log(
    r.verdict.padEnd(7),
    r.tab.padEnd(22),
    fmt(r.ms).padStart(7),
    `${r.budgetS.toFixed(1)}s`.padStart(7),
    fmtBytes(r.bytes).padStart(9),
    String(r.status).padStart(5),
    r.path + (r.err ? `  (${r.err})` : ""),
  );
}

const slow = rows.filter((r) => r.verdict === "SLOW");
const fail = rows.filter((r) => r.verdict === "FAIL");
console.log("");
console.log(`summary: ${rows.length} routes · ${slow.length} slow · ${fail.length} fail`);
if (slow.length) {
  console.log("slow:");
  for (const r of slow) console.log(`  - ${r.tab}: ${fmt(r.ms)} > ${r.budgetS}s budget (${fmtBytes(r.bytes)})`);
}
if (fail.length) {
  console.log("fail:");
  for (const r of fail) console.log(`  - ${r.tab}: http ${r.status} ${r.err ?? ""}`);
}

process.exit(fail.length || slow.filter((r) => r.critical).length ? 1 : 0);
