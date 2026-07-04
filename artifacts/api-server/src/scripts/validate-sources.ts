/**
 * Cross-source field validation: compare yahoo / edgar / finnhub values for the same
 * (ticker, field) pairs. Outputs a log file + trusted-fields.json for merge-trusted.ts.
 *
 * Comparison rules:
 *   Ratio fields (abs(v) <= 10): PASS if |a - b| <= 0.05
 *   Large number fields (abs(v) >= 1000): PASS if min/max >= 0.80 (within 20%)
 *   Scale mismatch: max/min > 50 → SCALE_MISMATCH (flagged, treated as FAIL)
 *   SKIP when < 2 sources have a value for that (ticker, field)
 *
 * Run: cd artifacts/api-server && /path/to/tsx src/scripts/validate-sources.ts
 */

import fs from "node:fs";
import path from "node:path";
import { db, sourceFundamentals } from "@workspace/db";
import { inArray } from "drizzle-orm";

const SOURCES = ["yahoo", "edgar", "finnhub"] as const;
const RATIO_THRESHOLD = 0.05;
const LARGE_NUMBER_RATIO = 0.80;
const SCALE_MISMATCH_RATIO = 50;
const TRUSTED_PASS_RATE = 0.80;

type SourceName = typeof SOURCES[number];

// ── Comparison helpers ────────────────────────────────────────────────────────

function isRatio(v: number): boolean {
  return Math.abs(v) <= 10;
}

function isLargeNumber(v: number): boolean {
  return Math.abs(v) >= 1000;
}

type CompareResult = "PASS" | "FAIL" | "SCALE_MISMATCH";

function compareTwo(a: number, b: number): CompareResult {
  if (a === 0 && b === 0) return "PASS";
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  const maxAbs = Math.max(absA, absB);
  const minAbs = Math.min(absA, absB);

  // Scale mismatch: one is in ratio range, other is very large, or huge ratio between them
  if (minAbs > 0 && maxAbs / minAbs > SCALE_MISMATCH_RATIO) {
    return "SCALE_MISMATCH";
  }

  if (isRatio(a) && isRatio(b)) {
    return Math.abs(a - b) <= RATIO_THRESHOLD ? "PASS" : "FAIL";
  }

  if (isLargeNumber(a) && isLargeNumber(b)) {
    // Different sign = FAIL
    if ((a > 0) !== (b > 0)) return "FAIL";
    return minAbs / maxAbs >= LARGE_NUMBER_RATIO ? "PASS" : "FAIL";
  }

  // Mixed range (one near-zero ratio, one small number)
  return Math.abs(a - b) <= RATIO_THRESHOLD ? "PASS" : "FAIL";
}

// Compare all pairs for a set of sources; ticker passes if ALL pairs pass
function compareAll(vals: Map<SourceName, number>): CompareResult {
  const entries = [...vals.entries()];
  let result: CompareResult = "PASS";
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const r = compareTwo(entries[i][1], entries[j][1]);
      if (r === "SCALE_MISMATCH") return "SCALE_MISMATCH";
      if (r === "FAIL") result = "FAIL";
    }
  }
  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Load all rows for our three sources
  const rows = await db
    .select()
    .from(sourceFundamentals)
    .where(inArray(sourceFundamentals.source, [...SOURCES]));

  // Group: field → ticker → source → value
  const data = new Map<string, Map<string, Map<SourceName, number>>>();
  for (const row of rows) {
    const field = row.field;
    const ticker = row.ticker;
    const source = row.source as SourceName;
    const value = parseFloat(String(row.value));
    if (!isFinite(value)) continue;

    if (!data.has(field)) data.set(field, new Map());
    const byTicker = data.get(field)!;
    if (!byTicker.has(ticker)) byTicker.set(ticker, new Map());
    byTicker.get(ticker)!.set(source, value);
  }

  // Only fields with 2+ sources
  const multiSourceFields = [...data.entries()].filter(([, byTicker]) => {
    const sourcesPresent = new Set<string>();
    for (const [, srcMap] of byTicker) for (const s of srcMap.keys()) sourcesPresent.add(s);
    return sourcesPresent.size >= 2;
  });

  // Get all tickers for context
  const allTickers = new Set<string>();
  for (const [, byTicker] of data) for (const t of byTicker.keys()) allTickers.add(t);

  const logLines: string[] = [];
  const summaryLines: string[] = [];
  const fieldStats: Record<string, {
    passes: number; fails: number; scaleMismatches: number; skips: number;
    sourcePassCount: Record<string, number>;
  }> = {};

  for (const [field, byTicker] of multiSourceFields.sort(([a], [b]) => a.localeCompare(b))) {
    logLines.push(`\nFIELD: ${field}`);
    let passes = 0, fails = 0, scaleMismatches = 0, skips = 0;
    const sourcePassCount: Record<string, number> = {};

    // All tickers that have any value for this field
    const tickersWithData = [...byTicker.keys()].sort();

    for (const ticker of tickersWithData) {
      const srcMap = byTicker.get(ticker)!;
      if (srcMap.size < 2) {
        const [src, val] = [...srcMap.entries()][0];
        logLines.push(`  ${ticker.padEnd(8)} ${src}=${val.toPrecision(4).padEnd(12)} → SKIP (only 1 source)`);
        skips++;
        continue;
      }

      const result = compareAll(srcMap);
      const valStr = [...srcMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([s, v]) => `${s}=${Number(v.toPrecision(4))}`)
        .join(" ");

      logLines.push(`  ${ticker.padEnd(8)} ${valStr.padEnd(60)} → ${result}`);

      if (result === "PASS") {
        passes++;
        for (const s of srcMap.keys()) sourcePassCount[s] = (sourcePassCount[s] ?? 0) + 1;
      } else if (result === "SCALE_MISMATCH") {
        scaleMismatches++;
      } else {
        fails++;
      }
    }

    fieldStats[field] = { passes, fails, scaleMismatches, skips, sourcePassCount };

    const comparable = passes + fails + scaleMismatches;
    const passRate = comparable > 0 ? passes / comparable : 0;
    const smFlag = scaleMismatches > 0 ? ` SCALE_MISMATCH=${scaleMismatches}` : "";
    summaryLines.push(
      `  ${field.padEnd(22)} PASS ${passes}/${comparable}${smFlag.padEnd(20)}  FAIL ${fails}  SKIP ${skips}  rate=${(passRate * 100).toFixed(0)}%`
    );
  }

  // Determine TRUSTED vs DISPUTED
  const trusted: Record<string, { preferredSource: string; passRate: number; fallbackSources: string[] }> = {};
  const disputed: Record<string, { passRate: number; topIssue: string }> = {};

  for (const [field, stats] of Object.entries(fieldStats)) {
    const comparable = stats.passes + stats.fails + stats.scaleMismatches;
    const passRate = comparable > 0 ? stats.passes / comparable : 0;

    // Preferred source = highest pass participation count, tie-break yahoo > finnhub > edgar
    const priority = ["yahoo", "finnhub", "edgar"];
    const sortedSources = Object.entries(stats.sourcePassCount)
      .sort(([aName, aCount], [bName, bCount]) => {
        if (bCount !== aCount) return bCount - aCount;
        return priority.indexOf(aName) - priority.indexOf(bName);
      });
    const preferredSource = sortedSources[0]?.[0] ?? "yahoo";
    const fallbackSources = sortedSources.slice(1).map(([s]) => s);

    if (passRate >= TRUSTED_PASS_RATE) {
      trusted[field] = { preferredSource, passRate, fallbackSources };
    } else {
      const topIssue = stats.scaleMismatches > stats.fails ? "SCALE_MISMATCH" : "HIGH_DIVERGENCE";
      disputed[field] = { passRate, topIssue };
    }
  }

  // Build full log
  const header = [
    "=== Source Validation Report ===",
    `Date: ${new Date().toISOString()}`,
    `Sources: ${SOURCES.join(", ")}`,
    `Thresholds: ratio ±${RATIO_THRESHOLD}, large_number min/max ≥ ${LARGE_NUMBER_RATIO}, scale_mismatch max/min > ${SCALE_MISMATCH_RATIO}`,
    "",
  ].join("\n");

  const summarySection = [
    "\n\nSUMMARY:",
    ...summaryLines,
  ].join("\n");

  const trustedSection = [
    "\n\nTRUSTED_FIELDS (pass rate ≥ 80%): safe to merge immediately",
    ...Object.entries(trusted).map(([f, info]) =>
      `  ${f.padEnd(22)} rate=${(info.passRate * 100).toFixed(0)}%  prefer=${info.preferredSource}  fallback=${info.fallbackSources.join(",")}`
    ),
  ].join("\n");

  const disputedSection = [
    "\n\nDISPUTED_FIELDS (pass rate < 80%): needs FMP as tiebreaker",
    ...Object.entries(disputed).map(([f, info]) =>
      `  ${f.padEnd(22)} rate=${(info.passRate * 100).toFixed(0)}%  issue=${info.topIssue}`
    ),
  ].join("\n");

  const fullLog = header + logLines.join("\n") + summarySection + trustedSection + disputedSection;

  const dateStr = new Date().toISOString().slice(0, 10);
  const logPath = path.join(process.cwd(), `logs/validate-sources-${dateStr}.log`);
  fs.writeFileSync(logPath, fullLog, "utf8");
  console.log(`Log written → ${logPath}`);

  // Write JSON for merge-trusted.ts
  const jsonPath = path.join(process.cwd(), "logs/trusted-fields.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ trusted, disputed }, null, 2), "utf8");
  console.log(`JSON written → ${jsonPath}`);

  // Console summary
  console.log("\nTRUSTED_FIELDS:");
  for (const [f, info] of Object.entries(trusted)) {
    console.log(`  ${f.padEnd(22)} ${(info.passRate * 100).toFixed(0)}%  prefer=${info.preferredSource}`);
  }
  console.log("\nDISPUTED_FIELDS:");
  for (const [f, info] of Object.entries(disputed)) {
    console.log(`  ${f.padEnd(22)} ${(info.passRate * 100).toFixed(0)}%  ${info.topIssue}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
