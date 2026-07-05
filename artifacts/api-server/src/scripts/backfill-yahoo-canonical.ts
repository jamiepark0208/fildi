/**
 * Backfill Yahoo Finance fundamentals for canonical tickers never yet attempted.
 *
 * Targets: fmp_fundamentals tickers NOT IN yahoo_fundamentals (120 tickers as
 * of 2026-07-05 audit).  The original backfill-yahoo.ts used peer_group_members
 * as its universe and missed these.
 *
 * Logic mirrors backfill-yahoo.ts exactly (same fetch, same upsert, same
 * concurrency) — only the ticker source changes.
 *
 * Run: cd artifacts/api-server && npx tsx src/scripts/backfill-yahoo-canonical.ts
 */

import fs from "node:fs";
import path from "node:path";
import { sql, notInArray } from "drizzle-orm";
import { db, fmpFundamentals, yahooFundamentals } from "@workspace/db";
import { fetchYahooFundamentals, type YahooFundamentalsData } from "../lib/yahoo-client.js";

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_CONCURRENT = 3;

const ZERO_AS_NULL_FIELDS: (keyof YahooFundamentalsData)[] = [
  "yahoo_annualCash",
  "yahoo_annualTotalDebt",
  "yahoo_annualTotalEquity",
  "yahoo_annualCapex",
  "yahoo_annualFreeCashFlow",
  "yahoo_annualOperatingCashFlow",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ts() { return new Date().toISOString(); }

function zeroToNull(data: YahooFundamentalsData): YahooFundamentalsData {
  const out = { ...data };
  for (const k of ZERO_AS_NULL_FIELDS) {
    if ((out[k] as number | undefined) === 0) (out as any)[k] = undefined;
  }
  return out;
}

function countFilled(data: YahooFundamentalsData): number {
  return Object.values(data).filter(v => v !== undefined && v !== null).length;
}

// ── Log file ──────────────────────────────────────────────────────────────────

const today   = new Date().toISOString().slice(0, 10);
const logDir  = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
const logFile = path.join(logDir, `backfill-yahoo-canonical-${today}.log`);

fs.mkdirSync(logDir, { recursive: true });

function appendLog(line: string): void {
  const stamped = `[${ts()}] ${line}`;
  console.log(stamped);
  fs.appendFileSync(logFile, stamped + "\n");
}

// ── Core per-ticker logic (mirrors backfill-yahoo.ts) ─────────────────────────

type TickerResult = { ticker: string; status: "ok" | "fail"; fields?: number; reason?: string };

async function processTicker(ticker: string): Promise<TickerResult> {
  let data: YahooFundamentalsData;
  try {
    data = await fetchYahooFundamentals(ticker);
  } catch (err: any) {
    const reason = err?.message ?? "unknown error";
    appendLog(`[${ticker}] FAIL — ${reason}`);
    return { ticker, status: "fail", reason };
  }

  data = zeroToNull(data);
  const fields = countFilled(data);

  try {
    await db
      .insert(yahooFundamentals)
      .values({
        ticker,
        fetchedAt: new Date(),
        yahooGrossMargins:            data.yahoo_grossMargins?.toString()            ?? null,
        yahooOperatingMargins:        data.yahoo_operatingMargins?.toString()        ?? null,
        yahooProfitMargins:           data.yahoo_profitMargins?.toString()           ?? null,
        yahooReturnOnEquity:          data.yahoo_returnOnEquity?.toString()          ?? null,
        yahooReturnOnAssets:          data.yahoo_returnOnAssets?.toString()          ?? null,
        yahooRevenueGrowth:           data.yahoo_revenueGrowth?.toString()           ?? null,
        yahooDebtToEquity:            data.yahoo_debtToEquity?.toString()            ?? null,
        yahooCurrentRatio:            data.yahoo_currentRatio?.toString()            ?? null,
        yahooTotalRevenue:            data.yahoo_totalRevenue?.toString()            ?? null,
        yahooTotalDebt:               data.yahoo_totalDebt?.toString()               ?? null,
        yahooTotalCash:               data.yahoo_totalCash?.toString()               ?? null,
        yahooFreeCashflow:            data.yahoo_freeCashflow?.toString()            ?? null,
        yahooOperatingCashflow:       data.yahoo_operatingCashflow?.toString()       ?? null,
        yahooEbitda:                  data.yahoo_ebitda?.toString()                  ?? null,
        yahooTargetMeanPrice:         data.yahoo_targetMeanPrice?.toString()         ?? null,
        yahooForwardPe:               data.yahoo_forwardPE?.toString()               ?? null,
        yahooPegRatio:                data.yahoo_pegRatio?.toString()                ?? null,
        yahooPriceToBook:             data.yahoo_priceToBook?.toString()             ?? null,
        yahooEnterpriseToEbitda:      data.yahoo_enterpriseToEbitda?.toString()      ?? null,
        yahooEnterpriseToRevenue:     data.yahoo_enterpriseToRevenue?.toString()     ?? null,
        yahooTrailingEps:             data.yahoo_trailingEps?.toString()             ?? null,
        yahooForwardEps:              data.yahoo_forwardEps?.toString()              ?? null,
        yahooBeta:                    data.yahoo_beta?.toString()                    ?? null,
        yahooSharesOutstanding:       data.yahoo_sharesOutstanding?.toString()       ?? null,
        yahooFloatShares:             data.yahoo_floatShares?.toString()             ?? null,
        yahooHeldPercentInsiders:     data.yahoo_heldPercentInsiders?.toString()     ?? null,
        yahooShortRatio:              data.yahoo_shortRatio?.toString()              ?? null,
        yahooAnnualTotalRevenue:      data.yahoo_annualTotalRevenue?.toString()      ?? null,
        yahooAnnualGrossProfit:       data.yahoo_annualGrossProfit?.toString()       ?? null,
        yahooAnnualEbit:              data.yahoo_annualEbit?.toString()              ?? null,
        yahooAnnualNetIncome:         data.yahoo_annualNetIncome?.toString()         ?? null,
        yahooAnnualRevenueYoy:        data.yahoo_annualRevenueYoy?.toString()        ?? null,
        yahooAnnualCash:              data.yahoo_annualCash?.toString()              ?? null,
        yahooAnnualTotalDebt:         data.yahoo_annualTotalDebt?.toString()         ?? null,
        yahooAnnualTotalEquity:       data.yahoo_annualTotalEquity?.toString()       ?? null,
        yahooAnnualOperatingCashFlow: data.yahoo_annualOperatingCashFlow?.toString() ?? null,
        yahooAnnualCapex:             data.yahoo_annualCapex?.toString()             ?? null,
        yahooAnnualFreeCashFlow:      data.yahoo_annualFreeCashFlow?.toString()      ?? null,
      })
      .onConflictDoUpdate({
        target: yahooFundamentals.ticker,
        set: {
          fetchedAt:                    sql`now()`,
          yahooGrossMargins:            sql`excluded.yahoo_gross_margins`,
          yahooOperatingMargins:        sql`excluded.yahoo_operating_margins`,
          yahooProfitMargins:           sql`excluded.yahoo_profit_margins`,
          yahooReturnOnEquity:          sql`excluded.yahoo_return_on_equity`,
          yahooReturnOnAssets:          sql`excluded.yahoo_return_on_assets`,
          yahooRevenueGrowth:           sql`excluded.yahoo_revenue_growth`,
          yahooDebtToEquity:            sql`excluded.yahoo_debt_to_equity`,
          yahooCurrentRatio:            sql`excluded.yahoo_current_ratio`,
          yahooTotalRevenue:            sql`excluded.yahoo_total_revenue`,
          yahooTotalDebt:               sql`excluded.yahoo_total_debt`,
          yahooTotalCash:               sql`excluded.yahoo_total_cash`,
          yahooFreeCashflow:            sql`excluded.yahoo_free_cashflow`,
          yahooOperatingCashflow:       sql`excluded.yahoo_operating_cashflow`,
          yahooEbitda:                  sql`excluded.yahoo_ebitda`,
          yahooTargetMeanPrice:         sql`excluded.yahoo_target_mean_price`,
          yahooForwardPe:               sql`excluded.yahoo_forward_pe`,
          yahooPegRatio:                sql`excluded.yahoo_peg_ratio`,
          yahooPriceToBook:             sql`excluded.yahoo_price_to_book`,
          yahooEnterpriseToEbitda:      sql`excluded.yahoo_enterprise_to_ebitda`,
          yahooEnterpriseToRevenue:     sql`excluded.yahoo_enterprise_to_revenue`,
          yahooTrailingEps:             sql`excluded.yahoo_trailing_eps`,
          yahooForwardEps:              sql`excluded.yahoo_forward_eps`,
          yahooBeta:                    sql`excluded.yahoo_beta`,
          yahooSharesOutstanding:       sql`excluded.yahoo_shares_outstanding`,
          yahooFloatShares:             sql`excluded.yahoo_float_shares`,
          yahooHeldPercentInsiders:     sql`excluded.yahoo_held_percent_insiders`,
          yahooShortRatio:              sql`excluded.yahoo_short_ratio`,
          yahooAnnualTotalRevenue:      sql`excluded.yahoo_annual_total_revenue`,
          yahooAnnualGrossProfit:       sql`excluded.yahoo_annual_gross_profit`,
          yahooAnnualEbit:              sql`excluded.yahoo_annual_ebit`,
          yahooAnnualNetIncome:         sql`excluded.yahoo_annual_net_income`,
          yahooAnnualRevenueYoy:        sql`excluded.yahoo_annual_revenue_yoy`,
          yahooAnnualCash:              sql`excluded.yahoo_annual_cash`,
          yahooAnnualTotalDebt:         sql`excluded.yahoo_annual_total_debt`,
          yahooAnnualTotalEquity:       sql`excluded.yahoo_annual_total_equity`,
          yahooAnnualOperatingCashFlow: sql`excluded.yahoo_annual_operating_cash_flow`,
          yahooAnnualCapex:             sql`excluded.yahoo_annual_capex`,
          yahooAnnualFreeCashFlow:      sql`excluded.yahoo_annual_free_cash_flow`,
        },
      });
  } catch (err: any) {
    appendLog(`[${ticker}] FAIL — ${err?.message ?? "db write failed"}`);
    return { ticker, status: "fail", reason: err?.message };
  }

  appendLog(`[${ticker}] OK — ${fields} fields`);
  return { ticker, status: "ok", fields };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  appendLog("backfill-yahoo-canonical starting");

  // Canonical tickers that have never been attempted by Yahoo
  const existing = await db.select({ ticker: yahooFundamentals.ticker }).from(yahooFundamentals);
  const existingTickers = existing.map(r => r.ticker);

  const targetRows = await db
    .select({ ticker: fmpFundamentals.ticker })
    .from(fmpFundamentals)
    .where(notInArray(fmpFundamentals.ticker, existingTickers));

  const targets = targetRows.map(r => r.ticker).sort();
  appendLog(`${targets.length} canonical tickers with no Yahoo coverage — fetching now`);

  const results: TickerResult[] = [];
  for (let i = 0; i < targets.length; i += MAX_CONCURRENT) {
    const chunk = targets.slice(i, i + MAX_CONCURRENT);
    const chunkResults = await Promise.all(chunk.map(t => processTicker(t)));
    results.push(...chunkResults);
  }

  const ok   = results.filter(r => r.status === "ok");
  const fail = results.filter(r => r.status === "fail");
  const totalFields = ok.reduce((s, r) => s + (r.fields ?? 0), 0);

  const summary = [
    "",
    "── backfill-yahoo-canonical summary ────────",
    `  Target tickers : ${targets.length}`,
    `  Fetched (ok)   : ${ok.length}`,
    `  Failed         : ${fail.length}`,
    `  Fields written : ${totalFields}`,
    `  Avg fields/ok  : ${ok.length ? (totalFields / ok.length).toFixed(1) : "n/a"}`,
    fail.length > 0 ? `  Failures       : ${fail.map(r => r.ticker).join(", ")}` : "",
    "────────────────────────────────────────────",
  ].filter(l => l !== "");

  for (const line of summary) appendLog(line);
}

main().catch(err => {
  appendLog(`FATAL — ${err.message}`);
  process.exit(1);
});
