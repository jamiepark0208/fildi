/**
 * Backfill Polygon.io financials for the canonical 256-ticker universe.
 *
 * Polygon covers: totalRevenue, netIncome, grossMargin (computed),
 * operatingMargin (computed), interestExpense, totalDebt,
 * totalStockholdersEquity, quarterlyOperatingCashFlow.
 *
 * Skip logic: if Yahoo or Edgar already have ALL Polygon fields for a ticker,
 * that ticker is skipped (Polygon adds nothing new for validation).
 *
 * Rate limit: 3 concurrent, 1s sleep between batches.
 *
 * Run: cd artifacts/api-server && npx tsx src/scripts/backfill-polygon.ts
 * Dry run: npx tsx src/scripts/backfill-polygon.ts --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { sql, eq, and, inArray } from "drizzle-orm";
import { db, fmpFundamentals, polygonFundamentals, sourceFundamentals } from "@workspace/db";
import { fetchPolygonFundamentals } from "../lib/polygon-client.js";

// ── Config ─────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const POLYGON_API_KEY = process.env.POLYGON_API_KEY ?? "";
const MAX_CONCURRENT = 3;

const POLYGON_FIELDS = [
  "totalRevenue", "netIncome", "grossMargin", "operatingMargin",
  "interestExpense", "totalDebt", "totalStockholdersEquity",
  "quarterlyOperatingCashFlow",
] as const;

const HIGHER_PRIORITY_SOURCES = ["yahoo", "edgar"];

// ── Log file ───────────────────────────────────────────────────────────────────

const today   = new Date().toISOString().slice(0, 10);
const logDir  = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
const logFile = path.join(logDir, `backfill-polygon-${today}.log`);

fs.mkdirSync(logDir, { recursive: true });

function ts() { return new Date().toISOString(); }

function appendLog(line: string): void {
  const stamped = `[${ts()}] ${line}`;
  console.log(stamped);
  fs.appendFileSync(logFile, stamped + "\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ── Core per-ticker logic ──────────────────────────────────────────────────────

type TickerResult = {
  ticker: string;
  status: "ok" | "skip" | "fail";
  fieldsWritten?: number;
  reason?: string;
};

async function coveredByHigherPriority(ticker: string): Promise<boolean> {
  const rows = await db
    .select({ field: sourceFundamentals.field })
    .from(sourceFundamentals)
    .where(
      and(
        eq(sourceFundamentals.ticker, ticker),
        inArray(sourceFundamentals.source, HIGHER_PRIORITY_SOURCES),
      ),
    );
  const covered = new Set(rows.map(r => r.field));
  return POLYGON_FIELDS.every(f => covered.has(f));
}

async function processTicker(ticker: string): Promise<TickerResult> {
  const allCovered = await coveredByHigherPriority(ticker);
  if (allCovered) {
    appendLog(`[${ticker}] SKIP — all Polygon fields covered by Yahoo/Edgar`);
    return { ticker, status: "skip" };
  }

  if (DRY_RUN) {
    appendLog(`[${ticker}] DRY-RUN — would fetch Polygon financials`);
    return { ticker, status: "ok", fieldsWritten: 0 };
  }

  let data: Awaited<ReturnType<typeof fetchPolygonFundamentals>>;
  try {
    data = await fetchPolygonFundamentals(ticker, POLYGON_API_KEY);
  } catch (err: any) {
    appendLog(`[${ticker}] FAIL — fetch error: ${err?.message ?? "unknown"}`);
    return { ticker, status: "fail", reason: err?.message };
  }

  const nonNull = Object.values(data).filter(v => v !== undefined && v !== null).length;
  if (nonNull === 0) {
    appendLog(`[${ticker}] SKIP — Polygon returned no data`);
    return { ticker, status: "skip", reason: "no data" };
  }

  try {
    await db
      .insert(polygonFundamentals)
      .values({
        ticker,
        fetchedAt: new Date(),
        polygonTotalRevenue:              data.totalRevenue              != null ? String(data.totalRevenue)              : null,
        polygonNetIncome:                 data.netIncome                 != null ? String(data.netIncome)                 : null,
        polygonInterestExpense:           data.interestExpense           != null ? String(data.interestExpense)           : null,
        polygonGrossMargin:               data.grossMargin               != null ? String(data.grossMargin)               : null,
        polygonOperatingMargin:           data.operatingMargin           != null ? String(data.operatingMargin)           : null,
        polygonTotalDebt:                 data.totalDebt                 != null ? String(data.totalDebt)                 : null,
        polygonTotalStockholdersEquity:   data.totalStockholdersEquity   != null ? String(data.totalStockholdersEquity)   : null,
        polygonQuarterlyOperatingCashFlow: data.quarterlyOperatingCashFlow != null ? String(data.quarterlyOperatingCashFlow) : null,
      })
      .onConflictDoUpdate({
        target: polygonFundamentals.ticker,
        set: {
          fetchedAt:                         sql`now()`,
          polygonTotalRevenue:               sql`excluded.polygon_total_revenue`,
          polygonNetIncome:                  sql`excluded.polygon_net_income`,
          polygonInterestExpense:            sql`excluded.polygon_interest_expense`,
          polygonGrossMargin:                sql`excluded.polygon_gross_margin`,
          polygonOperatingMargin:            sql`excluded.polygon_operating_margin`,
          polygonTotalDebt:                  sql`excluded.polygon_total_debt`,
          polygonTotalStockholdersEquity:    sql`excluded.polygon_total_stockholders_equity`,
          polygonQuarterlyOperatingCashFlow: sql`excluded.polygon_quarterly_operating_cash_flow`,
        },
      });
  } catch (err: any) {
    appendLog(`[${ticker}] FAIL — db write: ${err?.message ?? "unknown"}`);
    return { ticker, status: "fail", reason: err?.message };
  }

  appendLog(`[${ticker}] OK — ${nonNull} fields`);
  return { ticker, status: "ok", fieldsWritten: nonNull };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!POLYGON_API_KEY && !DRY_RUN) {
    appendLog("FATAL — POLYGON_API_KEY not set");
    process.exit(1);
  }

  appendLog(`backfill-polygon starting${DRY_RUN ? " (DRY RUN)" : ""}`);

  const rows = await db
    .select({ ticker: fmpFundamentals.ticker })
    .from(fmpFundamentals)
    .orderBy(fmpFundamentals.ticker);

  const tickers = rows.map(r => r.ticker);
  appendLog(`${tickers.length} canonical tickers`);

  const results: TickerResult[] = [];

  for (let i = 0; i < tickers.length; i += MAX_CONCURRENT) {
    const chunk = tickers.slice(i, i + MAX_CONCURRENT);
    const chunkResults = await Promise.all(chunk.map(t => processTicker(t)));
    results.push(...chunkResults);
    if (!DRY_RUN && i + MAX_CONCURRENT < tickers.length) {
      await sleep(1000);
    }
  }

  const ok      = results.filter(r => r.status === "ok");
  const skipped = results.filter(r => r.status === "skip");
  const failed  = results.filter(r => r.status === "fail");
  const totalFields = ok.reduce((s, r) => s + (r.fieldsWritten ?? 0), 0);

  const summary = [
    "",
    "── backfill-polygon summary ─────────────────",
    `  Mode           : ${DRY_RUN ? "DRY RUN" : "live"}`,
    `  Processed      : ${ok.length}`,
    `  Skipped        : ${skipped.length}`,
    `  Failed         : ${failed.length}`,
    `  Fields written : ${totalFields}`,
    failed.length > 0 ? `  Failures       : ${failed.map(r => r.ticker).join(", ")}` : "",
    "────────────────────────────────────────────",
  ].filter(Boolean);

  for (const line of summary) appendLog(line);
}

main().catch(err => {
  appendLog(`FATAL — ${err.message}`);
  process.exit(1);
});
