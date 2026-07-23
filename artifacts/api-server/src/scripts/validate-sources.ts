/**
 * Cross-source field validation (period-aware).
 *
 * Rules:
 *   TTM_ONLY fields (margins, returns, growth):  compare yahoo vs finnhub only — EDGAR is annual, period mismatch
 *   SKIP_VALIDATION fields (debtToEquity):       always skip — definitionally incompatible across sources
 *   Ratio fields (abs(v) ≤ 10):                  PASS if |a - b| ≤ 0.05 OR |a - b| / max(|a|, |b|) ≤ 0.10 (relative 10%)
 *   Mid-range fields (10 < abs(v) < 1000):       PASS if |a - b| / max(|a|, |b|) ≤ 0.10 (relative 10%)
 *   Large number fields (abs(v) ≥ 1000):         PASS if min/max ≥ 0.80 (within 20%)
 *   Scale mismatch (max/min > 50):               flag SCALE_MISMATCH, treated as FAIL
 *
 * Run: cd artifacts/api-server && /path/to/tsx src/scripts/validate-sources.ts
 */

import fs from "node:fs";
import path from "node:path";
import { db, sourceFundamentals } from "@workspace/db";
import { inArray } from "drizzle-orm";

const SOURCES = ["yahoo", "edgar", "finnhub"] as const;
type SourceName = typeof SOURCES[number];

// Fields where EDGAR must be excluded — period mismatch (EDGAR=annual, yahoo/finnhub=TTM)
const TTM_ONLY_FIELDS = new Set([
  "grossMargin", "operatingMargin", "netMargin",
  "returnOnEquity", "returnOnAssets",
  "revenueGrowth", "totalRevenue", "freeCashFlow",
  "operatingCashFlow", "ebitda",
]);

// Fields skipped entirely — sources use incompatible definitions
const SKIP_VALIDATION_FIELDS = new Set(["debtToEquity"]);

const TRUSTED_PASS_RATE = 0.80;

// ── Comparison logic ──────────────────────────────────────────────────────────

export type CompareResult = "PASS" | "FAIL" | "SCALE_MISMATCH";

export function compareTwo(a: number, b: number): CompareResult {
  if (a === 0 && b === 0) return "PASS";
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  const maxAbs = Math.max(absA, absB);
  const minAbs = Math.min(absA, absB);

  if (minAbs > 0 && maxAbs / minAbs > 50) return "SCALE_MISMATCH";

  // Large numbers (≥ 1000): within 20%
  if (absA >= 1000 && absB >= 1000) {
    if ((a > 0) !== (b > 0)) return "FAIL";
    return minAbs / maxAbs >= 0.80 ? "PASS" : "FAIL";
  }

  // Mid-range (10 < abs < 1000): relative 10%
  if (absA > 10 || absB > 10) {
    if ((a > 0) !== (b > 0)) return "FAIL";
    return maxAbs > 0 && Math.abs(a - b) / maxAbs <= 0.10 ? "PASS" : "FAIL";
  }

  // Ratio (abs ≤ 10): absolute ±0.05 floor (handles near-zero values where relative
  // diff is unstable) OR relative 10% (same tolerance as mid-range) — avoids a cliff
  // at the abs=10 boundary where a value just above 10 got 20x more slack than one
  // just below it.
  if (Math.abs(a - b) <= 0.05) return "PASS";
  return maxAbs > 0 && Math.abs(a - b) / maxAbs <= 0.10 ? "PASS" : "FAIL";
}

export function compareAll(vals: Map<string, number>): CompareResult {
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
  const rows = await db
    .select()
    .from(sourceFundamentals)
    .where(inArray(sourceFundamentals.source, [...SOURCES]));

  // Group: field → ticker → source → value
  const data = new Map<string, Map<string, Map<SourceName, number>>>();
  for (const row of rows) {
    if (SKIP_VALIDATION_FIELDS.has(row.field)) continue;
    const value = parseFloat(String(row.value));
    if (!isFinite(value)) continue;
    if (!data.has(row.field)) data.set(row.field, new Map());
    const byTicker = data.get(row.field)!;
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, new Map());
    byTicker.get(row.ticker)!.set(row.source as SourceName, value);
  }

  // Only keep fields with 2+ sources globally
  const multiSourceFields = [...data.entries()].filter(([, byTicker]) => {
    const srcs = new Set<string>();
    for (const [, sm] of byTicker) for (const s of sm.keys()) srcs.add(s);
    return srcs.size >= 2;
  });

  const logLines: string[] = [];
  const summaryLines: string[] = [];
  const fieldStats: Record<string, {
    passes: number; fails: number; scaleMismatches: number; skips: number;
    sourcePassCount: Record<string, number>;
  }> = {};

  for (const [field, byTicker] of multiSourceFields.sort(([a], [b]) => a.localeCompare(b))) {
    const isTtmOnly = TTM_ONLY_FIELDS.has(field);
    logLines.push(`\nFIELD: ${field}${isTtmOnly ? "  [TTM: yahoo+finnhub only]" : ""}`);
    let passes = 0, fails = 0, scaleMismatches = 0, skips = 0;
    const sourcePassCount: Record<string, number> = {};

    for (const [ticker, srcMap] of [...byTicker.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      // For TTM-only fields, drop EDGAR from comparison
      const effectiveMap = new Map(
        [...srcMap.entries()].filter(([s]) => !isTtmOnly || s !== "edgar")
      );

      if (effectiveMap.size < 2) {
        const [[src, val]] = [...srcMap.entries()];
        logLines.push(`  ${ticker.padEnd(8)} ${src}=${val.toPrecision(4)}  → SKIP (only 1 comparable source)`);
        skips++;
        continue;
      }

      const result = compareAll(effectiveMap);
      const valStr = [...effectiveMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([s, v]) => `${s}=${Number(v.toPrecision(4))}`)
        .join(" ");

      logLines.push(`  ${ticker.padEnd(8)} ${valStr.padEnd(55)} → ${result}`);

      if (result === "PASS") {
        passes++;
        for (const s of effectiveMap.keys()) sourcePassCount[s] = (sourcePassCount[s] ?? 0) + 1;
      } else if (result === "SCALE_MISMATCH") {
        scaleMismatches++;
      } else {
        fails++;
      }
    }

    fieldStats[field] = { passes, fails, scaleMismatches, skips, sourcePassCount };
    const comparable = passes + fails + scaleMismatches;
    const rate = comparable > 0 ? passes / comparable : 0;
    const smNote = scaleMismatches > 0 ? ` SM=${scaleMismatches}` : "";
    summaryLines.push(
      `  ${field.padEnd(22)} PASS ${passes}/${comparable}${smNote.padEnd(8)}  FAIL ${fails}  SKIP ${skips}  rate=${(rate * 100).toFixed(0)}%`
    );
  }

  // TRUSTED / DISPUTED
  const priority = ["yahoo", "finnhub", "edgar"];
  const trusted: Record<string, { preferredSource: string; passRate: number; fallbackSources: string[] }> = {};
  const disputed: Record<string, { passRate: number; topIssue: string }> = {};

  for (const [field, stats] of Object.entries(fieldStats)) {
    const comparable = stats.passes + stats.fails + stats.scaleMismatches;
    const passRate = comparable > 0 ? stats.passes / comparable : 0;
    const sorted = Object.entries(stats.sourcePassCount)
      .sort(([an, ac], [bn, bc]) => bc !== ac ? bc - ac : priority.indexOf(an) - priority.indexOf(bn));
    const preferredSource = sorted[0]?.[0] ?? "yahoo";
    const fallbackSources = sorted.slice(1).map(([s]) => s);

    if (passRate >= TRUSTED_PASS_RATE) {
      trusted[field] = { preferredSource, passRate, fallbackSources };
    } else {
      disputed[field] = {
        passRate,
        topIssue: stats.scaleMismatches > stats.fails ? "SCALE_MISMATCH" : "HIGH_DIVERGENCE",
      };
    }
  }

  // Add skipped fields to disputed with note
  for (const field of SKIP_VALIDATION_FIELDS) {
    disputed[field] = { passRate: 0, topIssue: "SKIP_VALIDATION (definitionally incompatible)" };
  }

  const header = [
    "=== Source Validation Report (period-aware) ===",
    `Date: ${new Date().toISOString()}`,
    `TTM-only fields (edgar excluded): ${[...TTM_ONLY_FIELDS].join(", ")}`,
    `Skip-validation fields: ${[...SKIP_VALIDATION_FIELDS].join(", ")}`,
    "",
  ].join("\n");

  const summarySection = "\n\nSUMMARY:\n" + summaryLines.join("\n");
  const trustedSection = "\n\nTRUSTED_FIELDS (pass rate ≥ 80%):\n" +
    Object.entries(trusted).map(([f, i]) =>
      `  ${f.padEnd(22)} rate=${(i.passRate * 100).toFixed(0)}%  prefer=${i.preferredSource}  fallback=${i.fallbackSources.join(",")}`
    ).join("\n");
  const disputedSection = "\n\nDISPUTED_FIELDS (pass rate < 80%):\n" +
    Object.entries(disputed).map(([f, i]) =>
      `  ${f.padEnd(22)} rate=${(i.passRate * 100).toFixed(0)}%  issue=${i.topIssue}`
    ).join("\n");

  const fullLog = header + logLines.join("\n") + summarySection + trustedSection + disputedSection;

  const dateStr = new Date().toISOString().slice(0, 10);
  const logPath = path.join(process.cwd(), `logs/validate-sources-${dateStr}.log`);
  fs.writeFileSync(logPath, fullLog, "utf8");

  const jsonPath = path.join(process.cwd(), "logs/trusted-fields.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ trusted, disputed }, null, 2), "utf8");

  console.log(`Log  → ${logPath}`);
  console.log(`JSON → ${jsonPath}\n`);

  console.log("TRUSTED_FIELDS:");
  for (const [f, i] of Object.entries(trusted)) {
    console.log(`  ${f.padEnd(22)} ${(i.passRate * 100).toFixed(0)}%  prefer=${i.preferredSource}`);
  }
  console.log("\nDISPUTED_FIELDS:");
  for (const [f, i] of Object.entries(disputed)) {
    console.log(`  ${f.padEnd(22)} ${(i.passRate * 100).toFixed(0)}%  ${i.topIssue}`);
  }

  process.exit(0);
}

const isMain = process.argv[1]?.endsWith("validate-sources.ts") || process.argv[1]?.endsWith("validate-sources.js");
if (isMain) main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
