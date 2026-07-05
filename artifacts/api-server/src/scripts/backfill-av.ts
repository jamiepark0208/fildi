/**
 * Backfill Alpha Vantage OVERVIEW for the canonical 256-ticker universe.
 *
 * AV quota: 25 requests/day. Script is resumable — saves a cursor file
 * (logs/av-cursor.json) tracking today's call count and last-processed ticker.
 * Re-running picks up where it left off without re-fetching already-done tickers.
 *
 * Skip logic: if Yahoo already has ALL AV fields for a ticker, skip it —
 * AV is lower priority than Yahoo for every field it covers.
 *
 * Rate limit: 1 concurrent (strict AV limit). 12s sleep between requests
 * to stay within the 5 req/min soft limit.
 *
 * Run: cd artifacts/api-server && npx tsx src/scripts/backfill-av.ts
 * Dry run: npx tsx src/scripts/backfill-av.ts --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { sql, eq, and, inArray } from "drizzle-orm";
import { db, fmpFundamentals, avFundamentals, sourceFundamentals } from "@workspace/db";
import { fetchAVOverview } from "../lib/alpha-vantage-client.js";

// ── Config ─────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const AV_API_KEY = process.env.ALPHA_VANTAGE_API_KEY ?? "";
const MAX_DAILY_CALLS = 25;
// 12s between requests: stays within 5 req/min free tier soft limit
const INTER_REQUEST_DELAY_MS = 12_000;

const AV_FIELDS = [
  "peRatio", "pegRatio", "forwardPe", "pbRatio", "dividendYield",
  "analystTargetPrice", "netMargin", "operatingMargin", "returnOnEquity",
  "totalRevenue", "ebitda", "beta",
] as const;

// Yahoo is higher priority for every AV field
const HIGHER_PRIORITY_SOURCES = ["yahoo"];

// ── Cursor file (quota + resume state) ────────────────────────────────────────

const logDir    = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
const cursorFile = path.join(logDir, "av-cursor.json");
const today      = new Date().toISOString().slice(0, 10);

fs.mkdirSync(logDir, { recursive: true });

interface Cursor {
  date: string;        // YYYY-MM-DD — resets quota when it changes
  callsToday: number;
  lastTicker: string | null;  // last ticker successfully processed (resume point)
  done: boolean;       // true = all tickers processed, nothing to resume
}

function readCursor(): Cursor {
  try {
    const raw = JSON.parse(fs.readFileSync(cursorFile, "utf8")) as Cursor;
    if (raw.date !== today) {
      // New day — reset quota but preserve lastTicker so we can continue
      return { date: today, callsToday: 0, lastTicker: raw.lastTicker, done: false };
    }
    return raw;
  } catch {
    return { date: today, callsToday: 0, lastTicker: null, done: false };
  }
}

function writeCursor(c: Cursor): void {
  fs.writeFileSync(cursorFile, JSON.stringify(c, null, 2));
}

// ── Log file ───────────────────────────────────────────────────────────────────

const logFile = path.join(logDir, `backfill-av-${today}.log`);

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
  status: "ok" | "skip" | "fail" | "quota_stop";
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
  // AV pbRatio maps to priceToBook in canonical field names — check both
  const avCanonicalFields = AV_FIELDS.map(f => f === "pbRatio" ? "priceToBook" : f);
  return avCanonicalFields.every(f => covered.has(f));
}

async function processTicker(ticker: string, cursor: Cursor): Promise<TickerResult> {
  // Quota check
  if (cursor.callsToday >= MAX_DAILY_CALLS) {
    return { ticker, status: "quota_stop", reason: `${cursor.callsToday}/${MAX_DAILY_CALLS} calls used today` };
  }

  const allCovered = await coveredByHigherPriority(ticker);
  if (allCovered) {
    appendLog(`[${ticker}] SKIP — all AV fields covered by Yahoo`);
    return { ticker, status: "skip" };
  }

  if (DRY_RUN) {
    appendLog(`[${ticker}] DRY-RUN — would fetch AV OVERVIEW`);
    return { ticker, status: "ok", fieldsWritten: 0 };
  }

  let data: Awaited<ReturnType<typeof fetchAVOverview>>;
  try {
    data = await fetchAVOverview(ticker, AV_API_KEY);
  } catch (err: any) {
    // AV limit errors count as a call — record and stop
    if (err?.message?.includes("AV API limit")) {
      cursor.callsToday = MAX_DAILY_CALLS; // force stop
      writeCursor(cursor);
      appendLog(`[${ticker}] QUOTA_STOP — AV rate limit hit: ${err.message}`);
      return { ticker, status: "quota_stop", reason: err.message };
    }
    appendLog(`[${ticker}] FAIL — fetch error: ${err?.message ?? "unknown"}`);
    return { ticker, status: "fail", reason: err?.message };
  }

  cursor.callsToday += 1;

  const nonNull = Object.values(data).filter(v => v !== undefined && v !== null).length;
  if (nonNull === 0) {
    appendLog(`[${ticker}] SKIP — AV returned no data`);
    cursor.lastTicker = ticker;
    writeCursor(cursor);
    return { ticker, status: "skip", reason: "no data" };
  }

  try {
    await db
      .insert(avFundamentals)
      .values({
        ticker,
        fetchedAt:            new Date(),
        avPeRatio:            data.peRatio            != null ? String(data.peRatio)            : null,
        avPegRatio:           data.pegRatio           != null ? String(data.pegRatio)           : null,
        avForwardPe:          data.forwardPe          != null ? String(data.forwardPe)          : null,
        avPbRatio:            data.pbRatio            != null ? String(data.pbRatio)            : null,
        avDividendYield:      data.dividendYield      != null ? String(data.dividendYield)      : null,
        avAnalystTargetPrice: data.analystTargetPrice != null ? String(data.analystTargetPrice) : null,
        avNetMargin:          data.netMargin          != null ? String(data.netMargin)          : null,
        avOperatingMargin:    data.operatingMargin    != null ? String(data.operatingMargin)    : null,
        avReturnOnEquity:     data.returnOnEquity     != null ? String(data.returnOnEquity)     : null,
        avTotalRevenue:       data.totalRevenue       != null ? String(data.totalRevenue)       : null,
        avEbitda:             data.ebitda             != null ? String(data.ebitda)             : null,
        avBeta:               data.beta               != null ? String(data.beta)               : null,
      })
      .onConflictDoUpdate({
        target: avFundamentals.ticker,
        set: {
          fetchedAt:            sql`now()`,
          avPeRatio:            sql`excluded.av_pe_ratio`,
          avPegRatio:           sql`excluded.av_peg_ratio`,
          avForwardPe:          sql`excluded.av_forward_pe`,
          avPbRatio:            sql`excluded.av_pb_ratio`,
          avDividendYield:      sql`excluded.av_dividend_yield`,
          avAnalystTargetPrice: sql`excluded.av_analyst_target_price`,
          avNetMargin:          sql`excluded.av_net_margin`,
          avOperatingMargin:    sql`excluded.av_operating_margin`,
          avReturnOnEquity:     sql`excluded.av_return_on_equity`,
          avTotalRevenue:       sql`excluded.av_total_revenue`,
          avEbitda:             sql`excluded.av_ebitda`,
          avBeta:               sql`excluded.av_beta`,
        },
      });
  } catch (err: any) {
    appendLog(`[${ticker}] FAIL — db write: ${err?.message ?? "unknown"}`);
    return { ticker, status: "fail", reason: err?.message };
  }

  cursor.lastTicker = ticker;
  writeCursor(cursor);

  appendLog(`[${ticker}] OK — ${nonNull} fields (${cursor.callsToday}/${MAX_DAILY_CALLS} calls today)`);
  return { ticker, status: "ok", fieldsWritten: nonNull };
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!AV_API_KEY && !DRY_RUN) {
    appendLog("FATAL — ALPHA_VANTAGE_API_KEY not set");
    process.exit(1);
  }

  const cursor = readCursor();
  appendLog(
    `backfill-av starting${DRY_RUN ? " (DRY RUN)" : ""}` +
    ` — ${cursor.callsToday}/${MAX_DAILY_CALLS} calls used today` +
    (cursor.lastTicker ? `, resuming after ${cursor.lastTicker}` : ", starting from beginning"),
  );

  if (cursor.done) {
    appendLog("All tickers already processed — nothing to do. Delete av-cursor.json to re-run.");
    return;
  }

  const rows = await db
    .select({ ticker: fmpFundamentals.ticker })
    .from(fmpFundamentals)
    .orderBy(fmpFundamentals.ticker);

  let tickers = rows.map(r => r.ticker);

  // Resume: skip everything up to and including lastTicker
  if (cursor.lastTicker) {
    const idx = tickers.indexOf(cursor.lastTicker);
    if (idx >= 0) {
      tickers = tickers.slice(idx + 1);
      appendLog(`Resuming: ${tickers.length} tickers remaining`);
    }
  }

  const results: TickerResult[] = [];
  let quotaStopped = false;

  for (const ticker of tickers) {
    const result = await processTicker(ticker, cursor);
    results.push(result);

    if (result.status === "quota_stop") {
      quotaStopped = true;
      appendLog(`Quota exhausted (${cursor.callsToday}/${MAX_DAILY_CALLS}). Re-run after midnight UTC.`);
      break;
    }

    if (!DRY_RUN && result.status === "ok") {
      await sleep(INTER_REQUEST_DELAY_MS);
    }
  }

  // Mark done if we processed everything without hitting quota
  if (!quotaStopped && !DRY_RUN) {
    cursor.done = true;
    writeCursor(cursor);
  }

  const ok      = results.filter(r => r.status === "ok");
  const skipped = results.filter(r => r.status === "skip");
  const failed  = results.filter(r => r.status === "fail");
  const totalFields = ok.reduce((s, r) => s + (r.fieldsWritten ?? 0), 0);

  const summary = [
    "",
    "── backfill-av summary ──────────────────────",
    `  Mode           : ${DRY_RUN ? "DRY RUN" : "live"}`,
    `  Processed      : ${ok.length}`,
    `  Skipped        : ${skipped.length}`,
    `  Failed         : ${failed.length}`,
    quotaStopped ? `  Quota stop     : after ${ok.length + skipped.length + failed.length} tickers` : "",
    `  Fields written : ${totalFields}`,
    `  Calls today    : ${cursor.callsToday}/${MAX_DAILY_CALLS}`,
    failed.length > 0 ? `  Failures       : ${failed.map(r => r.ticker).join(", ")}` : "",
    "────────────────────────────────────────────",
  ].filter(Boolean);

  for (const line of summary) appendLog(line);
}

main().catch(err => {
  appendLog(`FATAL — ${err.message}`);
  process.exit(1);
});
