/**
 * Coverage audit — per-field null counts, source staging diagnostics, and per-ticker drilldown.
 *
 * Modes:
 *   node dist/audit-coverage.mjs                    — full summary
 *   node dist/audit-coverage.mjs --ticker=AAPL      — drilldown for one ticker
 *   node dist/audit-coverage.mjs --field=wacc       — all tickers null for this field + why
 *   node dist/audit-coverage.mjs --suspicious       — statistical outlier + cross-source audit
 */
import { eq } from "drizzle-orm";
import {
  db, tickerFundamentals, tickerRegistry, sourceFundamentals, fieldProvenance,
  yahooFundamentals, fmpFundamentals, finnhubFundamentals,
  edgarFundamentals, polygonFundamentals, avFundamentals,
} from "@workspace/db";
import { FIELD_DEFS } from "./merge-trusted.js";

const VALID_FIELDS = FIELD_DEFS.filter(d => (d.tfCol as string) !== "grossProfit");

// CLI flags
const TICKER_ARG  = process.argv.find(a => a.startsWith("--ticker="))?.split("=")[1]?.toUpperCase();
const FIELD_ARG   = process.argv.find(a => a.startsWith("--field="))?.split("=")[1];
const SUSPICIOUS  = process.argv.includes("--suspicious");

// Staging table presence index: ticker → source → fetchedAt (non-null means "API was called")
type StagingIndex = Map<string, Map<string, Date | null>>;

async function buildStagingIndex(): Promise<StagingIndex> {
  const [yahoo, fmp, finnhub, edgar, polygon, av] = await Promise.all([
    db.select({ ticker: yahooFundamentals.ticker,   fetchedAt: yahooFundamentals.fetchedAt   }).from(yahooFundamentals),
    db.select({ ticker: fmpFundamentals.ticker,     fetchedAt: fmpFundamentals.fetchedAt     }).from(fmpFundamentals),
    db.select({ ticker: finnhubFundamentals.ticker, fetchedAt: finnhubFundamentals.fetchedAt }).from(finnhubFundamentals),
    db.select({ ticker: edgarFundamentals.ticker,   fetchedAt: edgarFundamentals.fetchedAt   }).from(edgarFundamentals),
    db.select({ ticker: polygonFundamentals.ticker, fetchedAt: polygonFundamentals.fetchedAt }).from(polygonFundamentals),
    db.select({ ticker: avFundamentals.ticker,      fetchedAt: avFundamentals.fetchedAt      }).from(avFundamentals),
  ]);
  const sourceRows: { source: string; ticker: string; fetchedAt: Date | null }[] = [
    ...yahoo.map(r => ({ source: "yahoo",         ...r })),
    ...fmp.map(r   => ({ source: "fmp",           ...r })),
    ...finnhub.map(r => ({ source: "finnhub",     ...r })),
    ...edgar.map(r  => ({ source: "edgar",        ...r })),
    ...polygon.map(r => ({ source: "polygon",     ...r })),
    ...av.map(r     => ({ source: "alpha_vantage",...r })),
  ];
  const idx: StagingIndex = new Map();
  for (const { ticker, source, fetchedAt } of sourceRows) {
    if (!idx.has(ticker)) idx.set(ticker, new Map());
    idx.get(ticker)!.set(source, fetchedAt);
  }
  return idx;
}

// ── Suspicious value audit ────────────────────────────────────────────────────

const LOG_TRANSFORM_FIELDS = new Set(["peRatio","forwardPe","pegRatio","priceToBook","priceToSales","evEbitda","evRevenue"]);
const NM_GROWTH_FIELDS     = new Set(["epsGrowth","revenueGrowthYoY","revenueGrowthYoyPrior"]);
const STALE_SINGLE_DAYS    = 180; // single-source value older than this → stale

function modifiedZScores(pairs: [string, number][], logTransform: boolean): Map<string, number> {
  if (pairs.length < 5) return new Map();
  const vals = pairs.map(([, v]) => logTransform ? Math.log(Math.max(Math.abs(v), 1e-6)) : v);
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const absDevs = vals.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = absDevs[Math.floor(absDevs.length / 2)];
  if (mad === 0) return new Map();
  return new Map(pairs.map(([ticker], i) => [ticker, 0.6745 * (vals[i] - median) / mad]));
}

async function auditSuspicious() {
  const [tfRows, regRows, sfRows, provRows] = await Promise.all([
    db.select().from(tickerFundamentals),
    db.select({
      ticker: tickerRegistry.ticker,
      peerGroupId: tickerRegistry.primaryPeerGroupId,
    }).from(tickerRegistry).where(eq(tickerRegistry.fetchFundamentals, true)),
    db.select({
      ticker: sourceFundamentals.ticker,
      source: sourceFundamentals.source,
      field:  sourceFundamentals.field,
      value:  sourceFundamentals.value,
      fetchedAt: sourceFundamentals.fetchedAt,
    }).from(sourceFundamentals),
    db.select({
      ticker:        fieldProvenance.ticker,
      field:         fieldProvenance.field,
      winningSource: fieldProvenance.winningSource,
      fetchedAt:     fieldProvenance.fetchedAt,
      divergent:     fieldProvenance.divergent,
    }).from(fieldProvenance),
  ]);

  const tfMap    = new Map(tfRows.map(r => [r.ticker, r]));
  const groupMap = new Map(regRows.map(r => [r.ticker, r.peerGroupId ?? "__unclassified"]));

  // source_fundamentals index: ticker → field → source → { value, fetchedAt }
  const sfIdx = new Map<string, Map<string, Map<string, { value: number; fetchedAt: Date | null }>>>();
  for (const r of sfRows) {
    if (!sfIdx.has(r.ticker)) sfIdx.set(r.ticker, new Map());
    const byField = sfIdx.get(r.ticker)!;
    if (!byField.has(r.field)) byField.set(r.field, new Map());
    byField.get(r.field)!.set(r.source, { value: Number(r.value), fetchedAt: r.fetchedAt });
  }

  // provenance index: ticker → field → { winningSource, fetchedAt, divergent }
  const provIdx = new Map<string, Map<string, typeof provRows[0]>>();
  for (const r of provRows) {
    if (!provIdx.has(r.ticker)) provIdx.set(r.ticker, new Map());
    provIdx.get(r.ticker)!.set(r.field, r);
  }

  const now = Date.now();
  const findings: {
    ticker: string; field: string; value: number;
    winningSource: string; fetchedAt: string;
    altSources: string; divergent: boolean;
    verdict: string; detail: string;
  }[] = [];

  for (const fd of VALID_FIELDS) {
    const tfCol = fd.tfCol as string;

    // Group values by peer group for z-score computation
    const byGroup = new Map<string, [string, number][]>();
    for (const [ticker, tf] of tfMap) {
      const raw = (tf as Record<string, unknown>)[tfCol];
      if (raw == null) continue;
      const v = Number(raw);
      if (!isFinite(v)) continue;
      const gid = groupMap.get(ticker) ?? "__unclassified";
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid)!.push([ticker, v]);
    }

    // Compute z-scores per group
    const zMap = new Map<string, number>();
    for (const [gid, pairs] of byGroup) {
      const scores = modifiedZScores(pairs, LOG_TRANSFORM_FIELDS.has(tfCol));
      for (const [ticker, z] of scores) zMap.set(`${gid}:${ticker}`, z);
    }

    for (const [ticker, tf] of tfMap) {
      const raw = (tf as Record<string, unknown>)[tfCol];
      if (raw == null) continue;
      const v = Number(raw);
      if (!isFinite(v)) continue;
      const gid = groupMap.get(ticker) ?? "__unclassified";
      const z = zMap.get(`${gid}:${ticker}`);
      const isStatOutlier = z != null && Math.abs(z) > 3.0;
      const isNearZeroBase = NM_GROWTH_FIELDS.has(tfCol) && Math.abs(v) > 10;

      if (!isStatOutlier && !isNearZeroBase) continue;

      const prov = provIdx.get(ticker)?.get(tfCol);
      const fetchedAt = prov?.fetchedAt ? new Date(prov.fetchedAt as unknown as string) : null;
      const ageDays = fetchedAt ? Math.floor((now - fetchedAt.getTime()) / 86_400_000) : null;
      const winningSource = prov?.winningSource ?? "unknown";
      const divergent = prov?.divergent ?? false;

      // Alt source values from source_fundamentals
      const altSources = sfIdx.get(ticker)?.get(tfCol);
      const altParts: string[] = [];
      if (altSources) {
        for (const [src, { value: av }] of altSources) {
          if (src !== winningSource) altParts.push(`${src}=${av.toFixed(4)}`);
        }
      }
      const sourceCount = (altSources?.size ?? 0);

      let verdict: string;
      let detail: string;
      if (isNearZeroBase) {
        verdict = "NEAR_ZERO_BASE";
        detail = `|value| > 10× — prior period likely near zero; display as N/M`;
      } else if (ageDays != null && ageDays > STALE_SINGLE_DAYS && sourceCount <= 1) {
        verdict = "STALE_SINGLE_SOURCE";
        detail = `${ageDays}d old, only 1 source — re-fetch candidate`;
      } else if (isStatOutlier && !divergent && sourceCount >= 2) {
        verdict = "STAT_OUTLIER_AGREE";
        detail = `z=${z!.toFixed(1)} — sources agree, likely real but unusual`;
      } else if (isStatOutlier && divergent) {
        verdict = "STAT_OUTLIER_DISAGREE";
        detail = `z=${z!.toFixed(1)} — sources disagree, investigate winning source`;
      } else {
        verdict = "STAT_OUTLIER";
        detail = `z=${z!.toFixed(1)}`;
      }

      findings.push({
        ticker, field: tfCol, value: v,
        winningSource, fetchedAt: ageDays != null ? `${ageDays}d ago` : "never",
        altSources: altParts.join(" | ") || "none",
        divergent, verdict, detail,
      });
    }
  }

  // Sort: stale/disagree first, then by |z| (stat outliers), then near-zero-base
  const ORDER: Record<string, number> = {
    STALE_SINGLE_SOURCE: 0, STAT_OUTLIER_DISAGREE: 1, STAT_OUTLIER: 2,
    STAT_OUTLIER_AGREE: 3, NEAR_ZERO_BASE: 4,
  };
  findings.sort((a, b) => (ORDER[a.verdict] ?? 9) - (ORDER[b.verdict] ?? 9));

  console.log(`\n── SUSPICIOUS VALUES (${findings.length} findings) ──\n`);
  const verdictGroups = new Map<string, typeof findings>();
  for (const f of findings) {
    if (!verdictGroups.has(f.verdict)) verdictGroups.set(f.verdict, []);
    verdictGroups.get(f.verdict)!.push(f);
  }
  for (const [verdict, items] of verdictGroups) {
    console.log(`\n  [${verdict}] — ${items.length} cases`);
    for (const f of items) {
      const val = Math.abs(f.value) > 1000 ? f.value.toFixed(0)
               : Math.abs(f.value) < 0.01  ? f.value.toExponential(2)
               : f.value.toFixed(4);
      const divFlag = f.divergent ? " ⚠divergent" : "";
      console.log(`    ${f.ticker.padEnd(8)} ${f.field.padEnd(28)} val=${val.padStart(12)}  src=${f.winningSource.padEnd(14)} fetched=${f.fetchedAt.padEnd(10)}  alt=[${f.altSources}]${divFlag}`);
      console.log(`             → ${f.detail}`);
    }
  }
  console.log(`\n  Action guide:`);
  console.log(`    STALE_SINGLE_SOURCE  → re-run nightly-enrichment --tickers=TICKER --fields=FIELD`);
  console.log(`    STAT_OUTLIER_DISAGREE → open provenance popover, set manual override or re-fetch`);
  console.log(`    STAT_OUTLIER_AGREE   → verify in provenance popover; likely real`);
  console.log(`    NEAR_ZERO_BASE       → UI shows N/M automatically, no data fix needed`);
}

async function main() {
  if (SUSPICIOUS) { await auditSuspicious(); return; }

  const [tfRows, regRows, sfRows, stagingIdx] = await Promise.all([
    db.select().from(tickerFundamentals),
    db.select({ ticker: tickerRegistry.ticker }).from(tickerRegistry).where(eq(tickerRegistry.fetchFundamentals, true)),
    db.select({ ticker: sourceFundamentals.ticker, source: sourceFundamentals.source, field: sourceFundamentals.field }).from(sourceFundamentals),
    buildStagingIndex(),
  ]);

  const allTickers = regRows.map(r => r.ticker);
  const tfMap = new Map(tfRows.map(r => [r.ticker, r]));

  // source_fundamentals index: ticker → source → Set<field> (non-null values only)
  const sfIndex = new Map<string, Map<string, Set<string>>>();
  for (const row of sfRows) {
    if (!sfIndex.has(row.ticker)) sfIndex.set(row.ticker, new Map());
    const bySource = sfIndex.get(row.ticker)!;
    if (!bySource.has(row.source)) bySource.set(row.source, new Set());
    bySource.get(row.source)!.add(row.field);
  }

  // ── --ticker drilldown ────────────────────────────────────────────────────
  if (TICKER_ARG) {
    const row = tfMap.get(TICKER_ARG);
    console.log(`\n═══ TICKER DRILLDOWN: ${TICKER_ARG} ═══`);
    if (!row) console.log("  ⚠  No row in ticker_fundamentals");

    const staging = stagingIdx.get(TICKER_ARG);
    const SOURCES = ["yahoo","fmp","finnhub","edgar","polygon","alpha_vantage"];
    console.log("\nStaging table status:");
    for (const src of SOURCES) {
      const fetched = staging?.get(src);
      console.log(`  ${src.padEnd(16)} ${fetched ? `fetched ${fetched.toISOString().slice(0,10)}` : "NEVER FETCHED"}`);
    }

    console.log("\nPer-field breakdown:");
    console.log(`  ${"FIELD".padEnd(28)} ${"TF VALUE".padEnd(14)} SOURCE_SF             STAGING`);
    console.log("  " + "─".repeat(90));
    for (const { tfCol, priority } of VALID_FIELDS) {
      const field = tfCol as string;
      const tfVal = row ? (row as Record<string, unknown>)[field] : undefined;
      const isNull = tfVal == null;

      const sfStatus = priority.map(([src, sfField]) => {
        const has = sfIndex.get(TICKER_ARG)?.get(src)?.has(sfField);
        return has ? `${src}✓` : null;
      }).filter(Boolean).join(", ") || "none";

      const stagingStatus = priority.map(([src]) => {
        const uniq = [...new Set(priority.filter(([s]) => s === src).map(([s]) => s))];
        return uniq.map(s => staging?.has(s) ? `${s}✓` : `${s}✗`);
      }).flat().filter((v, i, a) => a.indexOf(v) === i).join(" ");

      const tfDisplay = isNull ? "NULL" : String(tfVal).slice(0, 12);
      console.log(`  ${field.padEnd(28)} ${tfDisplay.padEnd(14)} sf:[${sfStatus.padEnd(18)}] staging:[${stagingStatus}]`);
    }
    return;
  }

  // ── --field drilldown ─────────────────────────────────────────────────────
  if (FIELD_ARG) {
    const fieldDef = VALID_FIELDS.find(d => (d.tfCol as string) === FIELD_ARG);
    if (!fieldDef) { console.log(`Unknown field: ${FIELD_ARG}`); return; }
    const { tfCol, priority } = fieldDef;
    const nullTickers = allTickers.filter(t => {
      const row = tfMap.get(t);
      return !row || (row as Record<string, unknown>)[tfCol as string] == null;
    });

    console.log(`\n═══ FIELD DRILLDOWN: ${FIELD_ARG} ═══`);
    console.log(`${nullTickers.length} / ${allTickers.length} tickers are null\n`);
    console.log(`Priority chain: ${priority.map(([s,f]) => `${s}:${f}`).join(" → ")}\n`);
    console.log(`${"TICKER".padEnd(8)} ${"TF".padEnd(6)}` + priority.map(([s]) => s.padEnd(16)).join(""));
    console.log("─".repeat(8 + 6 + priority.length * 16));

    for (const ticker of nullTickers) {
      const staging = stagingIdx.get(ticker);
      const row = tfMap.get(ticker);
      const tfVal = row ? String((row as Record<string, unknown>)[tfCol as string] ?? "NULL") : "NO_ROW";
      const cols = priority.map(([src, sfField]) => {
        const inSF = sfIndex.get(ticker)?.get(src)?.has(sfField);
        const fetched = staging?.has(src);
        if (inSF)    return "SF_HAS_VAL ".padEnd(16);
        if (fetched) return "FETCHED_NULL".padEnd(16);
        return      "NOT_FETCHED ".padEnd(16);
      });
      console.log(`${ticker.padEnd(8)} ${tfVal.padEnd(6)}${cols.join("")}`);
    }
    return;
  }

  // ── Full summary ──────────────────────────────────────────────────────────
  const totalTickers = allTickers.length;
  const missingRow = allTickers.filter(t => !tfMap.has(t));

  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  COVERAGE AUDIT  —  ${totalTickers} tickers with fetch_fundamentals=true`);
  console.log(`  ticker_fundamentals rows: ${tfRows.length}  |  missing rows: ${missingRow.length}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  if (missingRow.length) {
    console.log(`Tickers with NO row in ticker_fundamentals: ${missingRow.join(", ")}\n`);
  }

  // Per-field null analysis with staging diagnostics
  type FieldReport = {
    field: string; nullCount: number; sources: string[];
    neverFetched: number;   // staging table has no row
    fetchedNull: number;    // staging table has row but value not in source_fundamentals
    sfHasData: number;      // source_fundamentals has value but still null in TF (pipeline not run?)
  };

  const reports: FieldReport[] = [];
  for (const { tfCol, priority } of VALID_FIELDS) {
    const field = tfCol as string;
    let nullCount = 0, neverFetched = 0, fetchedNull = 0, sfHasData = 0;

    for (const ticker of allTickers) {
      const row = tfMap.get(ticker);
      const val = row ? (row as Record<string, unknown>)[field] : null;
      if (val != null) continue;
      nullCount++;

      // Check each source in priority chain
      const staging = stagingIdx.get(ticker);
      const bySF = sfIndex.get(ticker);
      let anyFetched = false, anySFData = false;

      for (const [src, sfField] of priority) {
        if (bySF?.get(src)?.has(sfField)) { anySFData = true; break; }
        if (staging?.has(src)) anyFetched = true;
      }

      if (anySFData)       sfHasData++;
      else if (anyFetched) fetchedNull++;
      else                 neverFetched++;
    }

    const sources = priority.map(([s]) => s).filter((s, i, a) => a.indexOf(s) === i);
    reports.push({ field, nullCount, sources, neverFetched, fetchedNull, sfHasData });
  }
  reports.sort((a, b) => b.nullCount - a.nullCount);

  console.log("── PER-FIELD NULL COUNTS ────────────────────────────────────────────────────────────");
  console.log(`${"FIELD".padEnd(28)} NULL  NEVER_FETCHED  FETCHED_NULL  SF_PIPELINE  SOURCES`);
  console.log("─".repeat(110));
  for (const r of reports) {
    const pct = Math.round((r.nullCount / totalTickers) * 100);
    const bar = pct === 0 ? "✓" : pct < 30 ? "▓" : pct < 70 ? "░" : "✗";
    console.log(
      `${r.field.padEnd(28)} ${bar} ${String(r.nullCount).padStart(3)}/${totalTickers}` +
      `  ${String(r.neverFetched).padStart(13)}  ${String(r.fetchedNull).padStart(12)}  ${String(r.sfHasData).padStart(11)}` +
      `  ${r.sources.join("→")}`
    );
  }

  // Staging table coverage
  const SOURCES = ["yahoo","fmp","finnhub","edgar","polygon","alpha_vantage"];
  console.log("\n── STAGING TABLE COVERAGE (rows in source-specific table) ──");
  for (const src of SOURCES) {
    const count = allTickers.filter(t => stagingIdx.get(t)?.has(src)).length;
    const sfCount = allTickers.filter(t => sfIndex.get(t)?.has(src)).length;
    console.log(`  ${src.padEnd(16)} staging: ${String(count).padStart(3)}/${totalTickers}  source_fundamentals: ${String(sfCount).padStart(3)}/${totalTickers}`);
  }

  // Worst tickers
  const tickerNulls = allTickers.map(ticker => {
    const row = tfMap.get(ticker);
    const nullCount = row ? VALID_FIELDS.filter(({ tfCol }) => (row as Record<string, unknown>)[tfCol as string] == null).length : VALID_FIELDS.length;
    return { ticker, nullCount };
  }).sort((a, b) => b.nullCount - a.nullCount);

  console.log(`\n── WORST 30 TICKERS (of ${VALID_FIELDS.length} fields) ──`);
  for (const { ticker, nullCount } of tickerNulls.filter(t => t.nullCount > 0).slice(0, 30)) {
    const pct = Math.round((nullCount / VALID_FIELDS.length) * 100);
    console.log(`  ${ticker.padEnd(8)} ${String(nullCount).padStart(3)} nulls (${String(pct).padStart(3)}%) ${"█".repeat(Math.round(pct / 5))}`);
  }
  const complete = tickerNulls.filter(t => t.nullCount === 0).length;
  console.log(`\n  Complete: ${complete}/${totalTickers}  |  Incomplete: ${totalTickers - complete}/${totalTickers}`);
  console.log(`\n  Drilldown: node dist/audit-coverage.mjs --ticker=AAPL`);
  console.log(`             node dist/audit-coverage.mjs --field=wacc`);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
