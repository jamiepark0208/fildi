#!/usr/bin/env node
/**
 * A241 daily recon — Mac vs GCP public DB (aggregates only; no full dumps).
 *
 * Loop (Jamie 10-24): run → analyze report → fix bugs → re-run until green.
 * Compare by TRADING DATE / as-of, not job runtime.
 *
 *   node scripts/parity/vm_vs_mac.mjs              # last 5 sessions
 *   node scripts/parity/vm_vs_mac.mjs --days=10
 *   node scripts/parity/vm_vs_mac.mjs --date=2026-10-23
 *
 * Exit: 0 green · 2 yellow (band/coverage soft) · 1 red (exact fail / freshness)
 * Report: scripts/parity/out/YYYY-MM-DD.md + findings append if red/yellow
 */
import { mkdirSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const OUT_DIR = join(__dirname, "out");
const FINDINGS = join(__dirname, "FINDINGS.md");

const PROJECT = process.env.FILDI_GCP_PROJECT || "fildi-public-5ef5e2";
const ZONE = process.env.FILDI_GCP_ZONE || "us-west1-b";
const INSTANCE = process.env.FILDI_GCP_INSTANCE || "fildi-public-1";
const MAC_URL = process.env.DATABASE_URL || "postgresql://jamiepark@127.0.0.1:5432/tradedash";
const PRICE_BAND = Number(process.env.PARITY_PRICE_BAND || "0.005"); // ±0.5%

function arg(name, def) {
  const a = process.argv.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : def;
}

function sh(cmd, opts = {}) {
  const r = spawnSync(cmd, {
    shell: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd}\n${r.stderr || r.stdout}`);
  }
  return (r.stdout || "").trim();
}

function macSql(sql) {
  const flat = sql.replace(/\s+/g, " ").trim();
  return sh(`psql "${MAC_URL}" -v ON_ERROR_STOP=1 -At -F $'\\t' -c ${JSON.stringify(flat)}`);
}

function vmSql(sql) {
  const flat = sql.replace(/\s+/g, " ").trim();
  const b64 = Buffer.from(flat).toString("base64");
  const remote = `echo ${b64} | base64 -d | sudo -u postgres psql -d tradedash -v ON_ERROR_STOP=1 -At -F $'\\t'`;
  return sh(
    `gcloud compute ssh ${INSTANCE} --project=${PROJECT} --zone=${ZONE} --command=${JSON.stringify(remote)}`,
    { env: { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH || ""}` } },
  );
}

function parseTsv(text) {
  if (!text) return [];
  return text.split("\n").filter(Boolean).map((line) => line.split("\t"));
}

function todayEt() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const days = Number(arg("--days", "5"));
  const oneDate = arg("--date", "");
  const reportDay = todayEt();
  const lines = [];
  const push = (s) => lines.push(s);

  push(`# Parity ${reportDay}`);
  push(`Mac vs VM \`${INSTANCE}\` · band ±${(PRICE_BAND * 100).toFixed(2)}% · days=${oneDate || days}`);
  push("");

  let red = 0;
  let yellow = 0;

  // ── Coverage: prices_historical last N distinct dates ──────────────────
  const dateFilter = oneDate
    ? `date = '${oneDate}'`
    : `date >= (SELECT max(date) - ${days - 1} FROM prices_historical)`;

  const macDates = parseTsv(macSql(`SELECT date::text, count(*) FROM prices_historical WHERE ${dateFilter} GROUP BY 1 ORDER BY 1`));
  const vmDates = parseTsv(vmSql(`SELECT date::text, count(*) FROM prices_historical WHERE ${dateFilter} GROUP BY 1 ORDER BY 1`));
  const macMap = new Map(macDates.map(([d, n]) => [d, Number(n)]));
  const vmMap = new Map(vmDates.map(([d, n]) => [d, Number(n)]));
  const allDates = [...new Set([...macMap.keys(), ...vmMap.keys()])].sort();

  push("## Coverage — prices_historical");
  push("| date | mac_rows | vm_rows | delta |");
  push("|---|---:|---:|---:|");
  for (const d of allDates) {
    const m = macMap.get(d) ?? 0;
    const v = vmMap.get(d) ?? 0;
    const delta = v - m;
    push(`| ${d} | ${m} | ${v} | ${delta} |`);
    if (m === 0 || v === 0) red++;
    else if (Math.abs(delta) / Math.max(m, 1) > 0.01) yellow++; // >1% row-count drift
  }
  push("");

  // ── Exact tier: OHLCV checksum per date (closed day) ───────────────────
  push("## Exact — OHLCV md5 by date (ticker,o,h,l,c,v ordered)");
  push("| date | mac_md5 | vm_md5 | match |");
  push("|---|---|---|---|");
  const checksumSql = (side) => `
    SELECT date::text,
      md5(string_agg(ticker || '|' || coalesce(open::text,'') || '|' || coalesce(high::text,'') || '|' ||
        coalesce(low::text,'') || '|' || coalesce(close::text,'') || '|' || coalesce(volume::text,''),
        ',' ORDER BY ticker))
    FROM prices_historical WHERE ${dateFilter}
    GROUP BY 1 ORDER BY 1`;
  // same SQL both sides
  const macCs = new Map(parseTsv(macSql(checksumSql())).map(([d, h]) => [d, h]));
  const vmCs = new Map(parseTsv(vmSql(checksumSql())).map(([d, h]) => [d, h]));
  for (const d of allDates) {
    const a = macCs.get(d) || "";
    const b = vmCs.get(d) || "";
    const ok = a && b && a === b;
    push(`| ${d} | ${a.slice(0, 10) || "—"} | ${b.slice(0, 10) || "—"} | ${ok ? "YES" : "NO"} |`);
    if (!ok) {
      // After P2 dump-only, NO is expected until VM jobs refresh same day — mark yellow not red if both have rows
      if ((macMap.get(d) ?? 0) > 0 && (vmMap.get(d) ?? 0) > 0) yellow++;
      else red++;
    }
  }
  push("");

  // ── Band tier: close diffs for latest date present on both ─────────────
  const bothDates = allDates.filter((d) => macMap.has(d) && vmMap.has(d));
  const bandDate = oneDate || bothDates[bothDates.length - 1];
  if (bandDate) {
    push(`## Band — close ±${(PRICE_BAND * 100).toFixed(2)}% on ${bandDate} (sample breaches)`);
    const macCloses = new Map(
      parseTsv(macSql(`SELECT ticker, close::text FROM prices_historical WHERE date='${bandDate}' AND close IS NOT NULL`)).map(
        ([t, c]) => [t, Number(c)],
      ),
    );
    const vmCloses = new Map(
      parseTsv(vmSql(`SELECT ticker, close::text FROM prices_historical WHERE date='${bandDate}' AND close IS NOT NULL`)).map(
        ([t, c]) => [t, Number(c)],
      ),
    );
    const breaches = [];
    const onlyMac = [];
    const onlyVm = [];
    for (const [t, mc] of macCloses) {
      if (!vmCloses.has(t)) {
        onlyMac.push(t);
        continue;
      }
      const vc = vmCloses.get(t);
      const rel = Math.abs(vc - mc) / Math.max(Math.abs(mc), 1e-9);
      if (rel > PRICE_BAND) breaches.push({ t, mc, vc, rel });
    }
    for (const t of vmCloses.keys()) if (!macCloses.has(t)) onlyVm.push(t);
    breaches.sort((a, b) => b.rel - a.rel);
    push(`tickers mac=${macCloses.size} vm=${vmCloses.size} only_mac=${onlyMac.length} only_vm=${onlyVm.length} breaches=${breaches.length}`);
    if (onlyMac.length || onlyVm.length) yellow++;
    if (breaches.length) {
      yellow++;
      push("| ticker | mac | vm | rel |");
      push("|---|---:|---:|---:|");
      for (const b of breaches.slice(0, 25)) {
        push(`| ${b.t} | ${b.mc} | ${b.vc} | ${(b.rel * 100).toFixed(3)}% |`);
      }
      if (breaches.length > 25) push(`… +${breaches.length - 25} more`);
    } else {
      push("no close breaches in band");
    }
    if (onlyMac.length) push(`only_mac (≤20): ${onlyMac.slice(0, 20).join(", ")}`);
    if (onlyVm.length) push(`only_vm (≤20): ${onlyVm.slice(0, 20).join(", ")}`);
    push("");
  }

  // ── model_recs coverage by snapshot_date ───────────────────────────────
  push("## Coverage — model_recs");
  try {
    const macR = parseTsv(macSql(`SELECT snapshot_date::text, count(*) FROM model_recs GROUP BY 1 ORDER BY 1 DESC LIMIT ${days}`));
    const vmR = parseTsv(vmSql(`SELECT snapshot_date::text, count(*) FROM model_recs GROUP BY 1 ORDER BY 1 DESC LIMIT ${days}`));
    push("| date | mac | vm |");
    push("|---|---:|---:|");
    const rd = new Set([...macR.map((r) => r[0]), ...vmR.map((r) => r[0])]);
    const mm = new Map(macR.map(([d, n]) => [d, n]));
    const vv = new Map(vmR.map(([d, n]) => [d, n]));
    for (const d of [...rd].sort().reverse()) {
      push(`| ${d} | ${mm.get(d) || 0} | ${vv.get(d) || 0} |`);
    }
  } catch (e) {
    push(`model_recs skip: ${e.message}`);
    yellow++;
  }
  push("");

  const status = red > 0 ? "RED" : yellow > 0 ? "YELLOW" : "GREEN";
  push(`## Verdict: **${status}** (red=${red} yellow=${yellow})`);
  push("");
  push("### Loop");
  push("1. Read this report + `scripts/parity/FINDINGS.md`");
  push("2. If RED/YELLOW: root-cause → patch (job/code/threshold) → re-run this script");
  push("3. Append one FINDINGS line per fixed issue with date + SHA");
  push("4. Clock for P5 pass only counts GREEN trading days");

  const reportPath = join(OUT_DIR, `${reportDay}.md`);
  writeFileSync(reportPath, lines.join("\n") + "\n");
  console.log(lines.join("\n"));
  console.log(`\nWrote ${reportPath}`);

  if (status !== "GREEN") {
    if (!existsSync(FINDINGS)) {
      writeFileSync(
        FINDINGS,
        "# A241 parity findings (analyze → fix → retest)\n\n| date | status | issue | fix / next |\n|---|---|---|---|\n",
      );
    }
    appendFileSync(
      FINDINGS,
      `| ${reportDay} | ${status} | auto: red=${red} yellow=${yellow} — see out/${reportDay}.md | pending analysis |\n`,
    );
  }

  process.exit(status === "RED" ? 1 : status === "YELLOW" ? 2 : 0);
}

try {
  main();
} catch (e) {
  console.error(e);
  process.exit(1);
}
