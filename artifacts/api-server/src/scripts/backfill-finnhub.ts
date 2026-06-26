/**
 * Backfill Finnhub fundamentals for watchlist + peer group tickers.
 *
 * Logic:
 *   - Scoped to WATCHLIST + their peer groups (mirrors backfill-edgar/yahoo scope)
 *   - Skip tickers where finnhub_fundamentals.fetchedAt < 7 days old
 *   - Upsert into finnhub_fundamentals only (never touches ticker_fundamentals)
 *   - Max 3 concurrent, 1200ms sleep between batches (Finnhub free: 50 calls/min)
 *   - Log to logs/backfill-finnhub-{date}.log
 *
 * Run: cd artifacts/api-server && /path/to/tsx src/scripts/backfill-finnhub.ts
 */

import fs from "node:fs";
import path from "node:path";
import { sql, inArray } from "drizzle-orm";
import { db, peerGroupMembers, tickerRegistry, finnhubFundamentals } from "@workspace/db";
import { WATCHLIST } from "../lib/constants.js";
import { fetchFinnhubFundamentals } from "../lib/finnhub-client.js";

const MAX_CONCURRENT  = 3;
const STALE_DAYS      = 7;
const BATCH_SLEEP_MS  = 1200; // 50 calls/min free tier

// ── Log file ──────────────────────────────────────────────────────────────────

const today   = new Date().toISOString().slice(0, 10);
const logDir  = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
const logFile = path.join(logDir, `backfill-finnhub-${today}.log`);
fs.mkdirSync(logDir, { recursive: true });

function appendLog(line: string): void {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  fs.appendFileSync(logFile, stamped + "\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isFresh(fetchedAt: Date | null): boolean {
  if (!fetchedAt) return false;
  return Date.now() - new Date(fetchedAt).getTime() < STALE_DAYS * 86_400_000;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function countFilled(data: Record<string, unknown>): number {
  return Object.values(data).filter(v => v !== undefined && v !== null).length;
}

// ── Per-ticker logic ──────────────────────────────────────────────────────────

type Result = { ticker: string; status: "ok" | "skip" | "fail"; fields?: number; reason?: string };

async function processTicker(ticker: string, freshSet: Set<string>): Promise<Result> {
  if (freshSet.has(ticker)) {
    appendLog(`[${ticker}] SKIP — fresh`);
    return { ticker, status: "skip" };
  }

  let data: Awaited<ReturnType<typeof fetchFinnhubFundamentals>>;
  try {
    data = await fetchFinnhubFundamentals(ticker);
  } catch (err: any) {
    const reason = err?.message ?? "fetch error";
    appendLog(`[${ticker}] FAIL — ${reason}`);
    return { ticker, status: "fail", reason };
  }

  const fields = countFilled(data as Record<string, unknown>);

  try {
    await db.insert(finnhubFundamentals)
      .values({
        ticker,
        fetchedAt: new Date(),
        finnhubPeRatio:               data.finnhub_peRatio?.toString()              ?? null,
        finnhubPbRatio:               data.finnhub_pbRatio?.toString()              ?? null,
        finnhubPsRatio:               data.finnhub_psRatio?.toString()              ?? null,
        finnhubPriceToBook:           data.finnhub_priceToBook?.toString()          ?? null,
        finnhubEv:                    data.finnhub_ev?.toString()                   ?? null,
        finnhubMarketCap:             data.finnhub_marketCap?.toString()            ?? null,
        finnhubGrossMargin:           data.finnhub_grossMargin?.toString()          ?? null,
        finnhubOperatingMargin:       data.finnhub_operatingMargin?.toString()      ?? null,
        finnhubNetMargin:             data.finnhub_netMargin?.toString()            ?? null,
        finnhubFcfMargin:             data.finnhub_fcfMargin?.toString()            ?? null,
        finnhubReturnOnEquity:        data.finnhub_returnOnEquity?.toString()       ?? null,
        finnhubReturnOnAssets:        data.finnhub_returnOnAssets?.toString()       ?? null,
        finnhubRoic:                  data.finnhub_roic?.toString()                 ?? null,
        finnhubRevenueGrowth:         data.finnhub_revenueGrowth?.toString()        ?? null,
        finnhubEpsGrowth:             data.finnhub_epsGrowth?.toString()            ?? null,
        finnhubDebtToEquity:          data.finnhub_debtToEquity?.toString()         ?? null,
        finnhubLongTermDebtToEquity:  data.finnhub_longTermDebtToEquity?.toString() ?? null,
        finnhubNetDebtToEquity:       data.finnhub_netDebtToEquity?.toString()      ?? null,
        finnhubCurrentRatio:          data.finnhub_currentRatio?.toString()         ?? null,
        finnhubQuickRatio:            data.finnhub_quickRatio?.toString()           ?? null,
        finnhubFcfPerShare:           data.finnhub_fcfPerShare?.toString()          ?? null,
        finnhubBookValue:             data.finnhub_bookValue?.toString()            ?? null,
        finnhubBeta:                  data.finnhub_beta?.toString()                 ?? null,
        finnhubEps:                   data.finnhub_eps?.toString()                  ?? null,
        finnhubEbitPerShare:          data.finnhub_ebitPerShare?.toString()         ?? null,
        finnhubEarningsPerShare:      data.finnhub_earningsPerShare?.toString()     ?? null,
        finnhub52weekHigh:            data.finnhub_52weekHigh?.toString()           ?? null,
        finnhub52weekLow:             data.finnhub_52weekLow?.toString()            ?? null,
      })
      .onConflictDoUpdate({
        target: finnhubFundamentals.ticker,
        set: {
          fetchedAt:                   sql`now()`,
          finnhubPeRatio:              sql`excluded.finnhub_pe_ratio`,
          finnhubPbRatio:              sql`excluded.finnhub_pb_ratio`,
          finnhubPsRatio:              sql`excluded.finnhub_ps_ratio`,
          finnhubPriceToBook:          sql`excluded.finnhub_price_to_book`,
          finnhubEv:                   sql`excluded.finnhub_ev`,
          finnhubMarketCap:            sql`excluded.finnhub_market_cap`,
          finnhubGrossMargin:          sql`excluded.finnhub_gross_margin`,
          finnhubOperatingMargin:      sql`excluded.finnhub_operating_margin`,
          finnhubNetMargin:            sql`excluded.finnhub_net_margin`,
          finnhubFcfMargin:            sql`excluded.finnhub_fcf_margin`,
          finnhubReturnOnEquity:       sql`excluded.finnhub_return_on_equity`,
          finnhubReturnOnAssets:       sql`excluded.finnhub_return_on_assets`,
          finnhubRoic:                 sql`excluded.finnhub_roic`,
          finnhubRevenueGrowth:        sql`excluded.finnhub_revenue_growth`,
          finnhubEpsGrowth:            sql`excluded.finnhub_eps_growth`,
          finnhubDebtToEquity:         sql`excluded.finnhub_debt_to_equity`,
          finnhubLongTermDebtToEquity: sql`excluded.finnhub_long_term_debt_to_equity`,
          finnhubNetDebtToEquity:      sql`excluded.finnhub_net_debt_to_equity`,
          finnhubCurrentRatio:         sql`excluded.finnhub_current_ratio`,
          finnhubQuickRatio:           sql`excluded.finnhub_quick_ratio`,
          finnhubFcfPerShare:          sql`excluded.finnhub_fcf_per_share`,
          finnhubBookValue:            sql`excluded.finnhub_book_value`,
          finnhubBeta:                 sql`excluded.finnhub_beta`,
          finnhubEps:                  sql`excluded.finnhub_eps`,
          finnhubEbitPerShare:         sql`excluded.finnhub_ebit_per_share`,
          finnhubEarningsPerShare:     sql`excluded.finnhub_earnings_per_share`,
          finnhub52weekHigh:           sql`excluded.finnhub_52week_high`,
          finnhub52weekLow:            sql`excluded.finnhub_52week_low`,
        },
      });
  } catch (err: any) {
    const reason = err?.message ?? "db write failed";
    appendLog(`[${ticker}] FAIL — ${reason}`);
    return { ticker, status: "fail", reason };
  }

  appendLog(`[${ticker}] OK — ${fields}/28 fields`);
  return { ticker, status: "ok", fields };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  appendLog("backfill-finnhub starting");

  if (!process.env.FINNHUB_API_KEY) {
    appendLog("FATAL — FINNHUB_API_KEY not set");
    process.exit(1);
  }

  // Scoped ticker list: WATCHLIST + their peer groups
  const upper = WATCHLIST.map((t: string) => t.toUpperCase());
  const regRows = await db
    .select({ ticker: tickerRegistry.ticker, primaryPeerGroupId: tickerRegistry.primaryPeerGroupId })
    .from(tickerRegistry)
    .where(inArray(tickerRegistry.ticker, upper));
  const groupIds = [...new Set(regRows.map(r => r.primaryPeerGroupId).filter((g): g is string => !!g))];
  const memberRows = groupIds.length > 0
    ? await db.select({ ticker: peerGroupMembers.ticker }).from(peerGroupMembers)
        .where(inArray(peerGroupMembers.groupId, groupIds))
    : [];
  const allTickers = [...new Set([...upper, ...memberRows.map(r => r.ticker.toUpperCase())])].sort();
  appendLog(`${allTickers.length} distinct tickers (${upper.length} watchlist + peers from ${groupIds.length} groups)`);

  // Check freshness
  const existing = await db.select({ ticker: finnhubFundamentals.ticker, fetchedAt: finnhubFundamentals.fetchedAt })
    .from(finnhubFundamentals);
  const freshSet = new Set(existing.filter(r => isFresh(r.fetchedAt)).map(r => r.ticker));
  appendLog(`${freshSet.size} tickers already fresh (< ${STALE_DAYS}d old) — will skip`);

  // Process with concurrency + sleep between batches
  const results: Result[] = [];
  for (let i = 0; i < allTickers.length; i += MAX_CONCURRENT) {
    const chunk = allTickers.slice(i, i + MAX_CONCURRENT);
    const chunkResults = await Promise.all(chunk.map(t => processTicker(t, freshSet)));
    results.push(...chunkResults);
    if (i + MAX_CONCURRENT < allTickers.length) await sleep(BATCH_SLEEP_MS);
  }

  // Summary
  const ok    = results.filter(r => r.status === "ok");
  const skip  = results.filter(r => r.status === "skip");
  const fail  = results.filter(r => r.status === "fail");
  const totalFields = ok.reduce((s, r) => s + (r.fields ?? 0), 0);

  const summary = [
    "",
    "── backfill-finnhub summary ─────────────────",
    `  Total tickers : ${allTickers.length}`,
    `  Processed     : ${ok.length}`,
    `  Skipped       : ${skip.length}`,
    `  Failed        : ${fail.length}`,
    `  Fields written: ${totalFields}`,
    ...(fail.length > 0 ? [`  Failures      : ${fail.map(r => r.ticker).join(", ")}`] : []),
    "─────────────────────────────────────────────",
  ];

  for (const line of summary) appendLog(line);
}

main().catch(err => {
  appendLog(`FATAL — ${err.message}`);
  process.exit(1);
});
