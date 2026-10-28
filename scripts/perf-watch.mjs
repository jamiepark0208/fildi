#!/usr/bin/env node
/**
 * perf-watch — automatic signals for the "only shows up under real use" bug class (Jamie 10-28):
 * restart loops, slow routes, hung requests, 5xx bursts, polling storms, a blocked event loop, vendor outages.
 * Reads the live API log (/tmp/fildi-logs/api.log, pino-pretty) + macOS sleep windows (a closed lid is not a hang).
 * Deterministic, no LLM, no network except a localhost healthz probe. Never edits tracked files.
 *
 *   node scripts/perf-watch.mjs              # write ~/.fildi/perf-watch.{json,md}; exit 1 when a signal trips
 *   node scripts/perf-watch.mjs --hours 24   # wider window
 *   node scripts/perf-watch.mjs --print      # also print the markdown
 *
 * agent_start step 5c prints the result for every agent; each signal carries the first check to run.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const HOURS = Number(args[args.indexOf("--hours") + 1]) || 6;
const LOG = process.env.FILDI_API_LOG ?? "/tmp/fildi-logs/api.log";
const OUT = join(homedir(), ".fildi");

// Budgets. Vendor-bound routes (live Schwab/Yahoo/Polygon calls by design) get a wider p95 budget.
const P95_BUDGET_MS = 2_000;
const VENDOR_P95_BUDGET_MS = 6_000;
const VENDOR_ROUTE = /^\/api\/(options\/:T$|schwab\/|stocks\/:T\/(short-interest|session-flow)|live\/prices)/;
const HANG_MS = 60_000;
const RESTARTS_PER_HOUR = 3;
const ERRORS_5XX = 5;
const STORM_PER_MIN = 60;
const HEALTHZ_MAX_MS = 300;

const PLAYBOOK = {
  restart_loop: "Read the log lines just before each 'Server listening': crash (stack) or file-watch restart? Each restart wipes every in-memory cache.",
  hung_request: "Find the awaited vendor call with no deadline (withDeadline / AbortSignal), or a shared getOrCompute promise that never settles.",
  slow_route: "Time each await in the handler. Usual causes: cache TTL ≤ the page's poll interval, a cold cache after restart, a per-row vendor fan-out. Fix pattern: serve the saved value + refresh in background.",
  errors_5xx: "Grep the log for the route's error/stack; reproduce with the same query string.",
  poll_storm: "Find the UI caller (refetchInterval, hover prefetch, effect loop) firing this route; cap in-flight + match interval to the server TTL.",
  event_loop_blocked: "Something synchronous is running on the API thread (big readFileSync / JSON.parse / execSync / CPU loop). Profile with --cpu-prof or bisect recent commits.",
  vendor_outage: "Vendor circuit opened repeatedly: probe the vendor (DNS, auth, rate limit) before touching code; make sure callers degrade to saved data.",
};

function parseSleepWindows() {
  try {
    const out = execFileSync("/usr/bin/pmset", ["-g", "log"], { encoding: "utf8", maxBuffer: 64 << 20, timeout: 20_000 });
    const wins = [];
    let start = null;
    for (const line of out.split("\n")) {
      const m = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}) (Sleep|Wake|DarkWake)\s/.exec(line);
      if (!m) continue;
      const t = Date.parse(m[1].replace(" ", "T").replace(/ ([+-]\d\d)(\d\d)$/, "$1:$2"));
      if (m[2] === "Sleep") start = t;
      else if (start != null) { wins.push([start, t]); start = null; }
    }
    if (start != null) wins.push([start, Date.now()]);
    return wins;
  } catch { return []; }
}

/** pino-pretty lines carry HH:MM:SS only — anchor the last line to the file's mtime and walk back across midnights. */
function parseLog() {
  if (!existsSync(LOG)) return { reqs: [], restarts: [], circuits: [] };
  const raw = readFileSync(LOG, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
  const stamps = [...raw.matchAll(/^\[(\d\d):(\d\d):(\d\d)\.(\d{3})\] (\w+) \((\d+)\): (.*)$/gm)];
  const anchor = statSync(LOG).mtime;
  const day0 = new Date(anchor); day0.setHours(0, 0, 0, 0);
  let dayOffset = 0;
  const times = new Array(stamps.length);
  for (let i = stamps.length - 1, next = Infinity; i >= 0; i--) {
    const [, h, mi, s, ms] = stamps[i];
    const secs = (+h) * 3600 + (+mi) * 60 + (+s) + (+ms) / 1000;
    if (secs > next + 3600) dayOffset -= 1;             // going back past midnight
    next = secs;
    times[i] = day0.getTime() + dayOffset * 86_400_000 + secs * 1000;
  }
  const reqs = [], restarts = [], circuits = [];
  for (let i = 0; i < stamps.length; i++) {
    const msg = stamps[i][7];
    const body = raw.slice(stamps[i].index, stamps[i + 1]?.index ?? raw.length);
    if (msg.startsWith("request completed")) {
      const url = /"url": "([^"]+)"/.exec(body)?.[1];
      const code = /"statusCode": (\d+)/.exec(body)?.[1];
      const rt = /responseTime: (\d+)/.exec(body)?.[1];
      if (url && code && rt && code !== "401") reqs.push({ end: times[i], ms: +rt, code: +code, route: normRoute(url) });
    } else if (msg.startsWith("Server listening")) restarts.push(times[i]);
    else if (msg.includes("circuit open")) circuits.push(times[i]);
  }
  return { reqs, restarts, circuits };
}

function normRoute(url) {
  return url.split("?")[0].replace(/\/[A-Z][A-Z0-9.^=-]{0,9}(?=\/|$)/g, "/:T").replace(/\/\d+(?=\/|$)/g, "/:id");
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function probeHealthz() {
  const ms = [];
  for (let i = 0; i < 5; i++) {
    const s = performance.now();
    try { await fetch("http://127.0.0.1:8080/api/healthz", { signal: AbortSignal.timeout(5_000) }); } catch { return null; }
    ms.push(Math.round(performance.now() - s));
    await new Promise((r) => setTimeout(r, 300));
  }
  return ms;
}

const { reqs, restarts, circuits } = parseLog();
const sleeps = parseSleepWindows();
const now = Date.now();
const since = now - HOURS * 3_600_000;
const overlapsSleep = (a, b) => sleeps.some(([s, w]) => a < w && b > s);
const win = reqs.filter((r) => r.end >= since && !overlapsSleep(r.end - r.ms, r.end));
const signals = [];
const add = (kind, key, evidence) => signals.push({ id: `${kind}:${key}`, kind, key, evidence, check: PLAYBOOK[kind] });

const lastHour = restarts.filter((t) => t >= now - 3_600_000);
if (lastHour.length > RESTARTS_PER_HOUR) add("restart_loop", "api", `${lastHour.length} API restarts in the last hour (${restarts.filter((t) => t >= since).length} in ${HOURS} h)`);

for (const r of win.filter((x) => x.ms >= HANG_MS)) add("hung_request", `${r.route}@${new Date(r.end).toISOString().slice(0, 16)}`, `${r.route} took ${Math.round(r.ms / 1000)} s (ended ${new Date(r.end).toLocaleString()}; Mac was awake)`);

const byRoute = new Map();
for (const r of win) (byRoute.get(r.route) ?? byRoute.set(r.route, []).get(r.route)).push(r);
for (const [route, rs] of byRoute) {
  if (route === "/api/healthz") continue;
  const ok = rs.filter((r) => r.ms < HANG_MS).map((r) => r.ms);
  const budget = VENDOR_ROUTE.test(route) ? VENDOR_P95_BUDGET_MS : P95_BUDGET_MS;
  if (ok.length >= 5 && pct(ok, 0.95) > budget) add("slow_route", route, `${route}: p50 ${pct(ok, 0.5)} ms · p95 ${pct(ok, 0.95)} ms over ${ok.length} calls (budget p95 ${budget} ms)`);
  const errs = rs.filter((r) => r.code >= 500).length;
  if (errs >= ERRORS_5XX) add("errors_5xx", route, `${route}: ${errs} × 5xx of ${rs.length} calls in ${HOURS} h`);
  const perMin = new Map();
  for (const r of rs) { const k = Math.floor(r.end / 60_000); perMin.set(k, (perMin.get(k) ?? 0) + 1); }
  const peak = Math.max(...perMin.values());
  if (peak > STORM_PER_MIN) add("poll_storm", route, `${route}: ${peak} calls in one minute (${rs.length} in ${HOURS} h)`);
}

const circ = circuits.filter((t) => t >= since);
if (circ.length >= 3) add("vendor_outage", "yahoo", `Yahoo circuit opened ${circ.length}× in ${HOURS} h`);

const hz = await probeHealthz();
if (hz && Math.max(...hz) > HEALTHZ_MAX_MS) add("event_loop_blocked", "api", `healthz probes ${hz.join(" / ")} ms (budget ${HEALTHZ_MAX_MS} ms) — API thread busy`);

// first-seen per signal id, so agents see what is new
mkdirSync(OUT, { recursive: true });
const statePath = join(OUT, "perf-watch-state.json");
let state = {};
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { /* first run */ }
for (const s of signals) { s.firstSeen = state[s.id] ?? new Date(now).toISOString(); state[s.id] = s.firstSeen; }
writeFileSync(statePath, JSON.stringify(Object.fromEntries(Object.entries(state).filter(([, t]) => now - Date.parse(t) < 14 * 86_400_000))));

const report = { at: new Date(now).toISOString(), hours: HOURS, requests: win.length, restarts: restarts.filter((t) => t >= since).length,
  healthz: hz, signals };
writeFileSync(join(OUT, "perf-watch.json"), JSON.stringify(report, null, 2));
const md = [`# perf-watch ${report.at.slice(0, 16)} · last ${HOURS} h · ${win.length} requests (sleep excluded) · ${report.restarts} restarts`,
  signals.length ? "" : "All clear.",
  ...signals.map((s) => `- **${s.kind}** ${s.evidence} (since ${s.firstSeen.slice(0, 16)})\n  - check: ${s.check}`)].join("\n");
writeFileSync(join(OUT, "perf-watch.md"), md + "\n");
if (args.includes("--print")) console.log(md);
else console.log(`perf-watch: ${signals.length ? `${signals.length} signal(s) — ${[...new Set(signals.map((s) => s.kind))].join(", ")}` : "all clear"} → ~/.fildi/perf-watch.md`);
process.exit(signals.length ? 1 : 0);
