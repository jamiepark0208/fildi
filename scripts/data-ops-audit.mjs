#!/usr/bin/env node
/**
 * Data-ops audit — constant drift + Stock DB scoreboard (filled/total like UI).
 *
 *   node scripts/data-ops-audit.mjs
 *   node scripts/data-ops-audit.mjs --json-only
 *
 * Writes: /tmp/fildi-logs/data-ops-audit-last.json
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execSync } from "node:child_process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_DIR = "/tmp/fildi-logs";
const OUT = `${LOG_DIR}/data-ops-audit-last.json`;
const jsonOnly = process.argv.includes("--json-only");

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

function search(pattern, paths) {
  const findings = [];
  for (const p of paths) {
    const r = spawnSync("grep", ["-rn", "-E", pattern, p], { encoding: "utf8" });
    for (const line of (r.stdout || "").trim().split("\n").filter(Boolean)) {
      findings.push(line);
    }
  }
  return findings;
}

function psqlJson(sql) {
  const pgBin = `${process.env.HOME}/Applications/Postgres.app/Contents/Versions/16/bin`;
  const dbUrl = process.env.DATABASE_URL || "postgresql://jamiepark@127.0.0.1:5432/tradedash";
  const tmp = `${LOG_DIR}/audit-scoreboard.sql`;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(tmp, sql);
    const out = execSync(`psql "${dbUrl}" -v ON_ERROR_STOP=1 -tA -f "${tmp}"`, {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${pgBin}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
      },
    }).trim();
    // psql may print NOTICE lines — take last JSON object line
    const line = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .pop();
    return line ? JSON.parse(line) : null;
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 240) };
  }
}

loadEnvLocal();
mkdirSync(LOG_DIR, { recursive: true });

const findings = [];
const srcRoot = resolve(ROOT, "artifacts/api-server/src");

const staleHits = search(String.raw`STALE_DAYS\s*=\s*[0-9]+`, [srcRoot]);
for (const line of staleHits) {
  if (line.includes("data-ops-config")) continue;
  if (line.includes("earnings-history") || line.includes("UPCOMING_STALE")) continue;
  if (line.includes("SHARED_STALE") || line.includes("DATA_OPS_STALE") || line.includes("DATA_HEALTH_STALE")) continue;
  findings.push({
    severity: "warn",
    code: "stale_days_literal",
    detail: line.replace(ROOT + "/", ""),
  });
}

const fmpCalls7 = search(String.raw`CALLS_PER_TICKER\s*=\s*7|length \* 7`, [srcRoot]);
for (const line of fmpCalls7) {
  if (line.includes("data-ops-config")) continue;
  findings.push({
    severity: "warn",
    code: "fmp_calls_legacy_7",
    detail: line.replace(ROOT + "/", ""),
  });
}

const goldWrites = search(String.raw`upsertFundamentals\(|writeFundamentalsRow\(`, [srcRoot]);
for (const line of goldWrites) {
  const rel = line.replace(ROOT + "/", "");
  const codePart = rel.includes(":") ? rel.split(":").slice(2).join(":") : rel;
  if (/^\s*(\/\/|\*|\/\*)/.test(codePart.trim())) continue;
  if (rel.includes("fundamentals-db.ts")) continue;
  if (rel.includes("backfill-fundamentals.ts")) {
    findings.push({ severity: "error", code: "legacy_backfill_still_writes_gold", detail: rel });
    continue;
  }
  if (rel.includes("stock-data-manager.ts")) {
    findings.push({ severity: "error", code: "sdm_must_not_write_gold", detail: rel });
  }
}

const scoreboard = psqlJson(`
SELECT json_build_object(
  'universe', (SELECT COUNT(*)::int FROM ticker_registry WHERE fetch_fundamentals),
  'fundRows', (SELECT COUNT(*)::int FROM ticker_fundamentals tf
    JOIN ticker_registry r ON r.ticker = tf.ticker AND r.fetch_fundamentals),
  'nr', (SELECT COUNT(*)::int FROM field_provenance WHERE divergent),
  'staleYahooPegProv', (
    SELECT COUNT(*)::int FROM field_provenance fp
    JOIN ticker_fundamentals tf ON tf.ticker = fp.ticker
    WHERE fp.field = 'pegRatio' AND tf.peg_ratio IS NULL
  ),
  'techRows', (SELECT COUNT(*)::int FROM ticker_technicals t
    JOIN ticker_registry r ON r.ticker = t.ticker AND r.fetch_fundamentals),
  'techMissing', (SELECT COUNT(*)::int FROM ticker_registry r
    LEFT JOIN ticker_technicals t ON t.ticker = r.ticker
    WHERE r.fetch_fundamentals AND t.ticker IS NULL),
  'factset', (SELECT json_build_object(
      'callsToday', calls_today, 'dailyLimit', daily_limit,
      'remaining', daily_limit - calls_today
    ) FROM data_sources WHERE name = 'factset'),
  'filled', (
    SELECT json_object_agg(field, filled)
    FROM (
      SELECT * FROM (VALUES
        ('peRatio', (SELECT COUNT(pe_ratio)::int FROM ticker_fundamentals tf JOIN ticker_registry r ON r.ticker=tf.ticker AND r.fetch_fundamentals)),
        ('pegRatio', (SELECT COUNT(peg_ratio)::int FROM ticker_fundamentals tf JOIN ticker_registry r ON r.ticker=tf.ticker AND r.fetch_fundamentals)),
        ('forwardPe', (SELECT COUNT(forward_pe)::int FROM ticker_fundamentals tf JOIN ticker_registry r ON r.ticker=tf.ticker AND r.fetch_fundamentals)),
        ('forwardPeg', (SELECT COUNT(forward_peg)::int FROM ticker_fundamentals tf JOIN ticker_registry r ON r.ticker=tf.ticker AND r.fetch_fundamentals)),
        ('operatingMargin', (SELECT COUNT(operating_margin)::int FROM ticker_fundamentals tf JOIN ticker_registry r ON r.ticker=tf.ticker AND r.fetch_fundamentals)),
        ('priceToBook', (SELECT COUNT(price_to_book)::int FROM ticker_fundamentals tf JOIN ticker_registry r ON r.ticker=tf.ticker AND r.fetch_fundamentals)),
        ('ebitda', (SELECT COUNT(ebitda)::int FROM ticker_fundamentals tf JOIN ticker_registry r ON r.ticker=tf.ticker AND r.fetch_fundamentals)),
        ('roic', (SELECT COUNT(roic)::int FROM ticker_fundamentals tf JOIN ticker_registry r ON r.ticker=tf.ticker AND r.fetch_fundamentals)),
        ('debtToEquity', (SELECT COUNT(debt_to_equity)::int FROM ticker_fundamentals tf JOIN ticker_registry r ON r.ticker=tf.ticker AND r.fetch_fundamentals)),
        ('returnOnEquity', (SELECT COUNT(return_on_equity)::int FROM ticker_fundamentals tf JOIN ticker_registry r ON r.ticker=tf.ticker AND r.fetch_fundamentals))
      ) AS v(field, filled)
    ) s
  ),
  'nrByField', (
    SELECT COALESCE(json_object_agg(field, n), '{}'::json)
    FROM (
      SELECT field, COUNT(*)::int AS n FROM field_provenance
      WHERE divergent GROUP BY field ORDER BY n DESC LIMIT 12
    ) x
  )
)
`);

if (scoreboard && !scoreboard.error && scoreboard.staleYahooPegProv > 0) {
  findings.push({
    severity: "error",
    code: "stale_peg_provenance",
    detail: `${scoreboard.staleYahooPegProv} provenance rows for null gold PEG`,
  });
}

const report = {
  generatedAt: new Date().toISOString(),
  findings,
  ok: !findings.some((f) => f.severity === "error"),
  scoreboard,
  notes: [
    "Coverage = filled/total like Stock DB UI (non-null gold / fetch_fundamentals universe)",
    "Canonical gold path: enrich-and-merge → populate → merge-trusted",
    "FactSet referee-only; drain via maintain --drain-nr=40",
    "Plan: .cursor/plans/stock-db-best-realistic.md",
  ],
};

writeFileSync(OUT, JSON.stringify(report, null, 2));

if (!jsonOnly) {
  console.log(`[data-ops-audit] ${report.ok ? "OK" : "ISSUES"}  findings=${findings.length}`);
  for (const f of findings.slice(0, 30)) {
    console.log(`  ${f.severity.padEnd(5)} ${f.code}  ${String(f.detail).slice(0, 120)}`);
  }
  if (scoreboard && !scoreboard.error) {
    const u = scoreboard.universe || scoreboard.fundRows || "?";
    console.log(`\nScoreboard (filled / universe=${u}):`);
    console.log(`  NR=${scoreboard.nr}  tech=${scoreboard.techRows}/${u} missing=${scoreboard.techMissing}`);
    console.log(`  stalePegProv=${scoreboard.staleYahooPegProv}  factsetRem=${scoreboard.factset?.remaining ?? "?"}`);
    const filled = scoreboard.filled || {};
    for (const [k, v] of Object.entries(filled)) {
      console.log(`  ${k}: ${v}/${u}`);
    }
    const nrTop = scoreboard.nrByField || {};
    const nrLine = Object.entries(nrTop)
      .slice(0, 8)
      .map(([k, v]) => `${k}=${v}`)
      .join("  ");
    if (nrLine) console.log(`  NR leaders: ${nrLine}`);
  } else if (scoreboard?.error) {
    console.log(`  scoreboard error: ${scoreboard.error}`);
  }
  console.log(`Log: ${OUT}`);
}

process.exit(report.ok ? 0 : 1);
