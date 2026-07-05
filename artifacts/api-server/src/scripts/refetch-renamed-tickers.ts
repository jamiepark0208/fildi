/**
 * One-shot re-fetch for tickers renamed in July 2026:
 *   DISH → ECHO, PSTG → P, SQ → XYZ
 *
 * Deletes stale Finnhub rows (originally fetched under old symbols) then
 * re-fetches under corrected symbols. Yahoo was already handled by
 * backfill-yahoo-canonical.ts after deleting the all-null renamed rows.
 *
 * Run: node build-script.mjs src/scripts/refetch-renamed-tickers.ts
 *      node --enable-source-maps dist/scripts/refetch-renamed-tickers.mjs
 */

import { sql, inArray } from "drizzle-orm";
import { db, finnhubFundamentals } from "@workspace/db";
import { fetchFinnhubFundamentals } from "../lib/finnhub-client.js";

const TARGETS = ["ECHO", "P", "XYZ"];

async function main() {
  console.log("Deleting stale Finnhub rows for renamed tickers...");
  const del = await db.delete(finnhubFundamentals).where(inArray(finnhubFundamentals.ticker, TARGETS));
  console.log(`Deleted ${(del as any).rowCount ?? "?"} rows`);

  for (const ticker of TARGETS) {
    let data: Awaited<ReturnType<typeof fetchFinnhubFundamentals>>;
    try {
      data = await fetchFinnhubFundamentals(ticker);
    } catch (err: any) {
      console.error(`[${ticker}] Finnhub FAIL: ${err?.message?.slice(0, 100)}`);
      continue;
    }

    const filled = Object.values(data as Record<string, unknown>).filter(v => v !== null && v !== undefined).length;

    try {
      await db.insert(finnhubFundamentals).values({
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
      }).onConflictDoUpdate({
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
      console.log(`[${ticker}] Finnhub OK — ${filled}/28 fields`);
    } catch (err: any) {
      console.error(`[${ticker}] Finnhub DB FAIL: ${err?.message?.slice(0, 100)}`);
    }
  }

  console.log("Done");
}

main().catch(e => { console.error("FATAL:", e.message); process.exit(1); });
