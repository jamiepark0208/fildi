#!/usr/bin/env node
/**
 * One-shot “is Fildi running as expected?” — Jamie / agents.
 *
 *   node scripts/fildi-ok.mjs
 *   COOKIE='connect.sid=…' node scripts/fildi-ok.mjs   # authed tab routes
 *
 * Layers (fail-fast on hard stack failure; soft warnings otherwise):
 *   1) ports — API :8080 + Vite :8081
 *   2) health-check.mjs --json (vendors + local)
 *   3) tab-perf.mjs (route latency / size budgets)
 *   4) last maintain report (anomalies, advisory)
 *
 * Exit 0 = stack + health + critical tab-perf ok.
 * Exit 1 = hard fail (down / health fail / critical slow/fail).
 * Exit 2 = soft only (maintain anomalies, AUTH without cookie, advisory).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = (process.env.BASE ?? "http://127.0.0.1:8080").replace(/\/$/, "");
const VITE = (process.env.VITE ?? "http://127.0.0.1:8081").replace(/\/$/, "");
const COOKIE = process.env.COOKIE ?? "";
const MAINTAIN = "/tmp/fildi-logs/maintain-last.json";

const lines = [];
let hard = 0;
let soft = 0;

function note(level, msg) {
  lines.push(`${level.padEnd(4)} ${msg}`);
  if (level === "FAIL") hard++;
  if (level === "WARN") soft++;
}

async function ping(url, ms = 3000) {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { ok: res.ok || res.status === 401, status: res.status, ms: performance.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, ms: performance.now() - t0, err: String(e.message ?? e) };
  }
}

function runNode(script, args = []) {
  return spawnSync(process.execPath, [resolve(ROOT, script), ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, BASE, COOKIE },
    timeout: 120_000,
  });
}

// ── 1) ports ──────────────────────────────────────────────────────────────────
const api = await ping(`${BASE}/api/healthz`);
const vite = await ping(VITE);
if (api.ok && api.status === 200) note("ok", `API  :8080 healthz ${(api.ms / 1000).toFixed(2)}s`);
else note("FAIL", `API  :8080 down/bad (${api.status || api.err})`);
if (vite.ok) note("ok", `Vite :8081 ${(vite.ms / 1000).toFixed(2)}s http ${vite.status}`);
else note("FAIL", `Vite :8081 down (${vite.err ?? vite.status})`);

// ── 2) health-check ───────────────────────────────────────────────────────────
const hc = runNode("scripts/health-check.mjs", ["--json"]);
if (hc.status === 0) {
  try {
    const j = JSON.parse(hc.stdout || "{}");
    const pass = j.pass ?? j.okCount ?? "?";
    const fail = j.fail ?? j.failCount ?? 0;
    const checks = j.results ?? j.checks ?? [];
    const failed = (Array.isArray(checks) ? checks : []).filter((c) => c && c.ok === false);
    if ((fail === 0 || j.ok === true) && failed.length === 0) note("ok", `health-check ${pass} pass / ${fail} fail`);
    else {
      note("FAIL", `health-check ${pass} pass / ${fail} fail`);
      for (const c of failed.slice(0, 5)) note("FAIL", `  · ${c.name}: ${c.detail ?? c.status}`);
    }
  } catch {
    note("ok", "health-check exit 0 (json parse soft)");
  }
} else {
  note("FAIL", `health-check exit ${hc.status}: ${(hc.stderr || hc.stdout || "").slice(0, 160)}`);
}

// ── 3) tab-perf ───────────────────────────────────────────────────────────────
const tp = runNode("scripts/tab-perf.mjs");
const tpOut = (tp.stdout || "") + (tp.stderr || "");
const slow = [...tpOut.matchAll(/^SLOW\s+(\S+)/gm)].map((m) => m[1]);
const failRows = [...tpOut.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => m[1]);
const authRows = [...tpOut.matchAll(/^AUTH\s+(\S+)/gm)].map((m) => m[1]);
const sum = tpOut.match(/summary:.*$/m)?.[0] ?? "";
if (tp.status === 0 && failRows.length === 0 && slow.length === 0) {
  note("ok", `tab-perf ${sum || "clean"}`);
} else if (failRows.length || slow.length) {
  note("FAIL", `tab-perf ${sum}`);
  for (const s of slow) note("FAIL", `  · slow ${s}`);
  for (const f of failRows) note("FAIL", `  · fail ${f}`);
} else {
  note("WARN", `tab-perf exit ${tp.status} ${sum}`);
}
if (authRows.length && !COOKIE) {
  note("WARN", `tab-perf ${authRows.length} AUTH routes skipped (set COOKIE= for full tab check)`);
}

// ── 4) maintain last ──────────────────────────────────────────────────────────
if (existsSync(MAINTAIN)) {
  try {
    const m = JSON.parse(readFileSync(MAINTAIN, "utf8"));
    const ageMin = m.ts ? Math.round((Date.now() - Date.parse(m.ts)) / 60_000) : null;
    const age = ageMin != null ? `${ageMin}m ago` : "?";
    if (m.ok && m.healthOk) note("ok", `maintain ${age} · health ${m.healthPass ?? "?"}/${(m.healthPass ?? 0) + (m.healthFail ?? 0)}`);
    else note("WARN", `maintain ${age} · ok=${m.ok} healthOk=${m.healthOk}`);
    const acts = m.actions ?? [];
    // fair_value_jumps_* = day-over-day FV Δ>30% with price Δ<5%. Often a *correction*
    // (e.g. 2026-10-21 yield-unit bug → 10-22 recovery), not a live data break — info only.
    const jumps = acts.find((a) => /fair_value_jumps_/i.test(String(a)));
    const noisy = acts.filter((a) => /anomaly/i.test(String(a)) && !/fair_value_jumps_/i.test(String(a)));
    if (jumps) note("ok", `maintain ${jumps} (FV MoM check — inspect if unexpected; not auto-bad)`);
    if (noisy.length) note("WARN", `maintain anomalies: ${noisy.slice(0, 3).join("; ")}`);
  } catch {
    note("WARN", "maintain-last.json unreadable");
  }
} else {
  note("WARN", "no maintain-last.json yet");
}

// ── print ─────────────────────────────────────────────────────────────────────
console.log(`fildi-ok  BASE=${BASE}  cookie=${COOKIE ? "yes" : "no"}`);
for (const L of lines) console.log(L);
const verdict = hard ? "NOT OK" : soft ? "OK (with warnings)" : "OK";
console.log("");
console.log(`verdict: ${verdict} · hard=${hard} soft=${soft}`);
console.log("next: A235 P1/P2 · say “fildi-ok” anytime → this script");
process.exit(hard ? 1 : soft ? 2 : 0);
