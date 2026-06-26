/**
 * Backfill SEC EDGAR fundamentals for watchlist + peer group tickers.
 *
 * Logic:
 *   - bootstrapCikCache() first — bulk fetch company_tickers.json → ticker_cik
 *   - Scoped to WATCHLIST + their peer groups (mirrors backfill-fundamentals scope)
 *   - Skip tickers where edgar_fundamentals.fetchedAt < 7 days old
 *   - Upsert into edgar_fundamentals only (never touches ticker_fundamentals)
 *   - Max 3 concurrent, 500ms sleep between batches to be respectful to EDGAR
 *   - Log to logs/backfill-edgar-{date}.log
 *
 * Run: cd artifacts/api-server && /path/to/tsx src/scripts/backfill-edgar.ts
 */

import fs from "node:fs";
import path from "node:path";
import { sql, inArray } from "drizzle-orm";
import { db, peerGroupMembers, tickerRegistry, edgarFundamentals } from "@workspace/db";
import { WATCHLIST } from "../lib/constants.js";
import { bootstrapCikCache, fetchEdgarFundamentals } from "../lib/edgar-client.js";

const MAX_CONCURRENT = 3;
const STALE_DAYS     = 7;
const BATCH_SLEEP_MS = 500;

// ── Log file ──────────────────────────────────────────────────────────────────

const today   = new Date().toISOString().slice(0, 10);
const logDir  = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
const logFile = path.join(logDir, `backfill-edgar-${today}.log`);
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

  let data: Awaited<ReturnType<typeof fetchEdgarFundamentals>>["data"];
  try {
    ({ data } = await fetchEdgarFundamentals(ticker));
  } catch (err: any) {
    const reason = err?.message ?? "fetch error";
    appendLog(`[${ticker}] FAIL — ${reason}`);
    return { ticker, status: "fail", reason };
  }

  const fields = countFilled(data);

  try {
    await db.insert(edgarFundamentals)
      .values({
        ticker,
        fetchedAt:               new Date(),
        edgarTotalRevenue:       data.edgar_totalRevenue?.toString()       ?? null,
        edgarGrossProfit:        data.edgar_grossProfit?.toString()        ?? null,
        edgarNetIncome:          data.edgar_netIncome?.toString()          ?? null,
        edgarEbit:               data.edgar_ebit?.toString()               ?? null,
        edgarEbitda:             null,
        edgarFreeCashFlow:       data.edgar_freeCashFlow?.toString()       ?? null,
        edgarOperatingCashFlow:  data.edgar_operatingCashFlow?.toString()  ?? null,
        edgarCapitalExpenditure: data.edgar_capitalExpenditure?.toString() ?? null,
        edgarCashAndEquivalents: data.edgar_cashAndEquivalents?.toString() ?? null,
        edgarTotalDebt:          data.edgar_totalDebt?.toString()          ?? null,
        edgarTotalEquity:        data.edgar_totalEquity?.toString()        ?? null,
        edgarInterestExpense:    data.edgar_interestExpense?.toString()    ?? null,
        edgarSharesOutstanding:  data.edgar_sharesOutstanding?.toString()  ?? null,
        edgarGrossMargin:        data.edgar_grossMargin?.toString()        ?? null,
        edgarNetMargin:          data.edgar_netMargin?.toString()          ?? null,
      })
      .onConflictDoUpdate({
        target: edgarFundamentals.ticker,
        set: {
          fetchedAt:               sql`now()`,
          edgarTotalRevenue:       sql`excluded.edgar_total_revenue`,
          edgarGrossProfit:        sql`excluded.edgar_gross_profit`,
          edgarNetIncome:          sql`excluded.edgar_net_income`,
          edgarEbit:               sql`excluded.edgar_ebit`,
          edgarEbitda:             sql`excluded.edgar_ebitda`,
          edgarFreeCashFlow:       sql`excluded.edgar_free_cash_flow`,
          edgarOperatingCashFlow:  sql`excluded.edgar_operating_cash_flow`,
          edgarCapitalExpenditure: sql`excluded.edgar_capital_expenditure`,
          edgarCashAndEquivalents: sql`excluded.edgar_cash_and_equivalents`,
          edgarTotalDebt:          sql`excluded.edgar_total_debt`,
          edgarTotalEquity:        sql`excluded.edgar_total_equity`,
          edgarInterestExpense:    sql`excluded.edgar_interest_expense`,
          edgarSharesOutstanding:  sql`excluded.edgar_shares_outstanding`,
          edgarGrossMargin:        sql`excluded.edgar_gross_margin`,
          edgarNetMargin:          sql`excluded.edgar_net_margin`,
        },
      });
  } catch (err: any) {
    const reason = err?.message ?? "db write failed";
    appendLog(`[${ticker}] FAIL — ${reason}`);
    return { ticker, status: "fail", reason };
  }

  appendLog(`[${ticker}] OK — ${fields}/15 fields`);
  return { ticker, status: "ok", fields };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  appendLog("backfill-edgar starting");

  // Bootstrap CIK cache from company_tickers.json
  appendLog("bootstrapping CIK cache…");
  const upserted = await bootstrapCikCache();
  appendLog(`CIK cache: ${upserted} entries upserted`);

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
  const existing = await db.select({ ticker: edgarFundamentals.ticker, fetchedAt: edgarFundamentals.fetchedAt })
    .from(edgarFundamentals);
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
    "── backfill-edgar summary ──────────────────",
    `  Total tickers : ${allTickers.length}`,
    `  Processed     : ${ok.length}`,
    `  Skipped       : ${skip.length}`,
    `  Failed        : ${fail.length}`,
    `  Fields written: ${totalFields}`,
    ...(fail.length > 0 ? [`  Failures      : ${fail.map(r => r.ticker).join(", ")}`] : []),
    "────────────────────────────────────────────",
  ];

  for (const line of summary) appendLog(line);
}

main().catch(err => {
  appendLog(`FATAL — ${err.message}`);
  process.exit(1);
});
