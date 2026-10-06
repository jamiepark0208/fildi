/**
 * Add tickers to the Fildi stock universe WITHOUT adding them to anyone's watchlist.
 * Uses the same path as POST /watchlist minus the watchlist row:
 *   ticker_registry upsert (ETFs → fetchFundamentals=false) → peer auto-classify → fundamentals
 *   (budget-tracked via recordApiUsage) → technicals → verification report.
 *
 * Usage (from artifacts/api-server, env from repo .env.local):
 *   tsx src/scripts/add-universe-tickers.ts APP NBIS OKLO ...            # add / enrich
 *   tsx src/scripts/add-universe-tickers.ts --reactivate IOND SKHY       # also set is_active=true
 *   tsx src/scripts/add-universe-tickers.ts --dry-run APP                # report only
 */
import { inArray, sql } from "drizzle-orm";
import { db, pool, tickerRegistry, isExcludedEtf } from "@workspace/db";
import { enrichAndMergeTickers } from "../lib/enrich-and-merge.js";
import { refreshTechnicals } from "../lib/technicals-db.js";

async function report(tickers: string[]) {
  const r = await pool.query(
    `SELECT t.ticker, r.is_active, r.fetch_fundamentals, pg.name AS peer_group,
            f.data_quality_score IS NOT NULL OR f.total_revenue IS NOT NULL AS has_fundamentals,
            tt.technicals_last_fetched IS NOT NULL AS has_technicals, tt.atm_put_iv
     FROM unnest($1::text[]) AS t(ticker)
     LEFT JOIN ticker_registry r ON r.ticker = t.ticker
     LEFT JOIN peer_group_members m ON m.ticker = t.ticker AND m.removed_at IS NULL
     LEFT JOIN peer_groups pg ON pg.id = m.group_id
     LEFT JOIN ticker_fundamentals f ON UPPER(f.ticker) = t.ticker
     LEFT JOIN ticker_technicals tt ON UPPER(tt.ticker) = t.ticker
     ORDER BY 1`,
    [tickers],
  );
  for (const x of r.rows) {
    const etf = isExcludedEtf(x.ticker);
    const ok = x.is_active && x.has_technicals && (etf || (x.peer_group && x.has_fundamentals));
    console.log(
      `${ok ? "✓" : "✗"} ${x.ticker.padEnd(6)} ${etf ? "ETF/fund" : "stock   "} active=${x.is_active ?? "—"} ` +
        `peer=${etf ? "n/a (excluded)" : x.peer_group ?? "UNMAPPED"} fundamentals=${etf ? "n/a" : x.has_fundamentals ? "yes" : "NO"} ` +
        `technicals=${x.has_technicals ? "yes" : "NO"}${x.atm_put_iv ? ` iv=${x.atm_put_iv}` : ""}`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  const reactivate = args.includes("--reactivate");
  const tickers = [...new Set(args.filter((a) => !a.startsWith("--")).map((t) => t.toUpperCase()))];
  if (!tickers.length) throw new Error("usage: add-universe-tickers.ts [--reactivate] [--dry-run] TICKER ...");
  if (dry) return report(tickers);

  if (reactivate) {
    await db.update(tickerRegistry).set({ isActive: true }).where(inArray(tickerRegistry.ticker, tickers));
    console.log(`reactivated: ${tickers.join(" ")}`);
  }
  const res = await enrichAndMergeTickers(tickers, { respectMutex: true });
  console.log(`enrich: fetched=${res.fetched} failed=${res.failed}${res.skipped ? ` SKIPPED (${res.reason})` : ""}`);
  await refreshTechnicals(tickers);
  const usage = await pool.query(
    `SELECT source, calls_made FROM api_usage WHERE date = (now() AT TIME ZONE 'America/Los_Angeles')::date ORDER BY 1`,
  );
  console.log("api_usage today:", usage.rows.map((u) => `${u.source}=${u.calls_made}`).join(" "));
  await report(tickers);
  void sql;
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
