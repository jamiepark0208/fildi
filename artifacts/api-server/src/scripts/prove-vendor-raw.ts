/**
 * A266 proof: one fetch cycle for up to 10 names, inside vendor budgets.
 * Run: cd artifacts/api-server && nice -n 15 pnpm exec tsx src/scripts/prove-vendor-raw.ts
 */
import { loadEnvLocal } from "../lib/load-env-local.js";

loadEnvLocal();

const NAMES = ["JPM", "AAPL", "CAVA", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "XOM", "BAC"];
const FIELDS = [
  "forward_pe", "peg_ttm", "eps_growth_5y", "revenue_growth_5y", "payout_ratio",
  "interest_coverage", "price_to_fcf", "fcf_yield", "sbc_to_revenue", "income_quality",
  "price_to_tbv", "tier1_capital_ratio", "total_capital_ratio", "rotce",
  "net_interest_income", "total_deposits", "tangible_book_value_per_share",
];

const { pool } = await import("@workspace/db");
const { usageCalendarDate } = await import("../lib/usage-date.js");
const { fetchFinnhubFundamentals } = await import("../lib/finnhub-client.js");
const { fetchFMPFundamentals } = await import("../lib/fmp-client.js");
const { fetchYahooFundamentals } = await import("../lib/yahoo-client.js");
const { fetchEdgarFundamentals } = await import("../lib/edgar-client.js");
const { fetchAVOverview } = await import("../lib/alpha-vantage-client.js");
const { runFactsetReferee } = await import("../lib/factset-referee.js");
const { runMergeTrusted } = await import("./merge-trusted.js");
const { polygonApiKey, polygonFetch } = await import("../lib/polygon-limiter.js");
const { rememberVendorPayload } = await import("../lib/vendor-raw.js");
const { getSchwabDailyBars, schwabAvailable } = await import("../lib/schwab-client.js");
const { vendorRawFromHttpUrl } = await import("../lib/dropped-vendor-fields.js");

const today = usageCalendarDate();

async function budget(source: string, fallbackLimit: number): Promise<{ limit: number; used: number; left: number }> {
  const lim = await pool.query<{ daily_limit: number }>(
    `SELECT daily_limit FROM data_sources WHERE name = $1 AND is_active`,
    [source],
  );
  const limit = Number(lim.rows[0]?.daily_limit ?? fallbackLimit);
  const use = await pool.query<{ calls_made: number }>(
    `SELECT calls_made FROM api_usage WHERE source = $1 AND date = $2::date`,
    [source, today],
  );
  const used = Number(use.rows[0]?.calls_made ?? 0);
  return { limit, used, left: limit - used };
}

const notes: string[] = [];
const fmpKey = process.env.FMP_API_KEY ?? "";
const avKey = process.env.ALPHA_VANTAGE_API_KEY ?? process.env.AV_API_KEY ?? "";

const finn = await budget("finnhub", 9999);
const fmpB = await budget("fmp", 220);
const fsB = await budget("factset", 500);
const avB = await budget("alpha_vantage", 25);
notes.push(`budget finnhub ${finn.used}/${finn.limit} fmp ${fmpB.used}/${fmpB.limit} factset ${fsB.used}/${fsB.limit} av ${avB.used}/${avB.limit}`);

const finnN = Math.max(0, Math.min(NAMES.length, finn.left));
for (const t of NAMES.slice(0, finnN)) {
  try { await fetchFinnhubFundamentals(t); }
  catch (err) { notes.push(`finnhub ${t} fail ${String(err).slice(0, 120)}`); }
}

for (const t of NAMES) {
  try { await fetchYahooFundamentals(t); }
  catch (err) { notes.push(`yahoo ${t} fail ${String(err).slice(0, 80)}`); }
}

const fmpEach = 9;
const fmpRoom = fmpB.left - 15;
const fmpN = fmpKey && fmpRoom >= fmpEach
  ? Math.min(NAMES.length, Math.floor(fmpRoom / fmpEach))
  : 0;
if (!fmpKey) notes.push("fmp skipped: no key");
else if (fmpN === 0) notes.push(`fmp skipped: ${fmpB.left} left, keep 15`);
for (const t of NAMES.slice(0, fmpN)) {
  try { await fetchFMPFundamentals(t, fmpKey, "a266-prove"); }
  catch (err) { notes.push(`fmp ${t} fail ${String(err).slice(0, 120)}`); }
}

const fsRoom = fsB.left - 5;
const fsN = fsRoom >= 1 ? Math.min(NAMES.length, fsRoom) : 0;
if (fsN === 0) notes.push(`factset skipped: ${fsB.left} left`);
else {
  const r = await runFactsetReferee({ tickers: NAMES.slice(0, fsN), maxTickers: fsN });
  notes.push(`factset fetched ${r.fetched} failed ${r.failed} fields ${r.fieldsWritten}`);
}

for (const t of ["AAPL", "JPM", "CAVA"]) {
  try { await fetchEdgarFundamentals(t); }
  catch (err) { notes.push(`edgar ${t} fail ${String(err).slice(0, 80)}`); }
}

if (avKey && avB.left >= 5) {
  try { await fetchAVOverview("AAPL", avKey); }
  catch (err) { notes.push(`av fail ${String(err).slice(0, 120)}`); }
} else notes.push(`av skipped: left ${avB.left}`);

const polyKey = polygonApiKey();
if (polyKey) {
  const url = `https://api.polygon.io/stocks/v1/short-interest?ticker=AAPL&limit=5&apiKey=${polyKey}`;
  try {
    const res = await polygonFetch(url);
    if (res.ok) {
      const body = await res.json();
      const id = vendorRawFromHttpUrl("polygon", url);
      await rememberVendorPayload({ ...id, key: "AAPL", endpoint: "/stocks/v1/short-interest", payload: body });
    } else notes.push(`polygon short-interest HTTP ${res.status}`);
  } catch (err) { notes.push(`polygon fail ${String(err).slice(0, 80)}`); }
} else notes.push("polygon skipped: no key");

if (schwabAvailable()) {
  try {
    const bars = await getSchwabDailyBars("AAPL", "2026-10-01");
    notes.push(`schwab daily bars ${bars?.length ?? 0}`);
  } catch (err) { notes.push(`schwab fail ${String(err).slice(0, 80)}`); }
} else notes.push("schwab skipped: no credentials");

notes.push("merge start");
await runMergeTrusted();
notes.push("merge done");

const raw = await pool.query<{ source: string; n: string }>(
  `SELECT source, count(*)::text AS n FROM vendor_raw GROUP BY source ORDER BY source`,
);
const gold = await pool.query(
  `SELECT ticker, ${FIELDS.join(", ")} FROM ticker_fundamentals WHERE ticker = ANY($1::text[]) ORDER BY ticker`,
  [["AAPL", "JPM", "CAVA"]],
);
const src = await pool.query(
  `SELECT ticker, source, field, value FROM source_fundamentals
   WHERE ticker = ANY($1::text[]) AND field = ANY($2::text[])
   ORDER BY ticker, field, source`,
  [["AAPL", "JPM", "CAVA"], [
    "forwardPe", "pegTtm", "epsGrowth5Y", "revenueGrowth5Y", "payoutRatio", "interestCoverage",
    "priceToFcf", "fcfYield", "sbcToRevenue", "incomeQuality", "priceToTbv",
    "tier1CapitalRatio", "totalCapitalRatio", "rotce", "netInterestIncome", "totalDeposits",
    "tangibleBookValuePerShare",
  ]],
);

console.log(JSON.stringify({ notes, vendor_raw: raw.rows, gold: gold.rows, source: src.rows }, null, 2));
await pool.end();
