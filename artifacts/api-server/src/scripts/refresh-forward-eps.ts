/**
 * Refresh forward EPS where the only pull is older than 45 days.
 * Yahoo quoteSummary is the horizon. FMP annual consensus is the second source:
 * the open fiscal year whose EPS is closest to that Yahoo number, so the two
 * shares are the same year. One FMP call and one Yahoo call per ticker.
 *
 *   pnpm exec tsx src/scripts/refresh-forward-eps.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { withDeadline, yahooFinance } from "../lib/yahoo-client.js";

const STALE_DAYS = 45;
const FMP_CAP = 40;
const AGREE = 0.15;

type Est = { date: string; eps: number };

async function mapPool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
}

async function yahooForwardEps(ticker: string): Promise<number | null> {
  const symbol = ticker.replace(".", "-");
  const raw = await withDeadline(
    yahooFinance.quoteSummary(symbol, { modules: ["defaultKeyStatistics"] }, { validateResult: false }),
    20_000,
    `yahoo ${ticker}`,
  );
  const v = Number((raw as { defaultKeyStatistics?: { forwardEps?: number } }).defaultKeyStatistics?.forwardEps);
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function fmpEstimates(ticker: string, apiKey: string): Promise<Est[]> {
  const url = `https://financialmodelingprep.com/stable/analyst-estimates?symbol=${encodeURIComponent(ticker)}&period=annual&limit=8&apikey=${apiKey}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return [];
    const rows = await res.json() as { date?: string; epsAvg?: number }[];
    if (!Array.isArray(rows)) return [];
    return rows
      .map(r => ({ date: String(r.date ?? "").slice(0, 10), eps: Number(r.epsAvg) }))
      .filter(r => r.date && Number.isFinite(r.eps) && r.eps > 0);
  } finally {
    clearTimeout(timer);
  }
}

/** Open fiscal years (end date not more than 40 days ago). Closest EPS to Yahoo. */
function matchingYear(ests: Est[], yahoo: number | null): Est | null {
  const cutoff = Date.now() - 40 * 86_400_000;
  const open = ests.filter(e => new Date(`${e.date}T00:00:00Z`).getTime() >= cutoff);
  const pool = open.length > 0 ? open : ests;
  if (pool.length === 0) return null;
  if (yahoo == null) return null;
  return [...pool].sort((a, b) => Math.abs(a.eps - yahoo) - Math.abs(b.eps - yahoo))[0]!;
}

async function main() {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) throw new Error("FMP_API_KEY missing");
  const listed = await db.execute<{ ticker: string }>(sql`
    WITH live AS (
      SELECT f.ticker FROM ticker_fundamentals f
      JOIN ticker_registry r ON r.ticker = f.ticker AND r.fetch_fundamentals
    ),
    fwd AS (
      SELECT ticker, max(fetched_at) AS latest
      FROM source_fundamentals
      WHERE field = 'forwardEps' AND value::float8 > 0
      GROUP BY ticker
    )
    SELECT l.ticker
    FROM live l
    LEFT JOIN fwd ON fwd.ticker = l.ticker
    WHERE fwd.latest IS NULL OR fwd.latest < now() - interval '45 days'
    ORDER BY l.ticker
  `);
  const tickers = listed.rows.map(r => r.ticker);
  console.log(`stale or missing forward EPS: ${tickers.length}`);

  let yahooOk = 0;
  let fmpOk = 0;
  let agree = 0;
  let disagree = 0;
  let fmpUsed = 0;
  const changed: string[] = [];

  await mapPool(tickers, 1, async (ticker) => {
    let y: number | null = null;
    try {
      y = await yahooForwardEps(ticker);
    } catch (err) {
      console.log(`yahoo fail ${ticker} ${String((err as Error).message ?? err).slice(0, 80)}`);
    }
    if (y != null) {
      await db.execute(sql`
        INSERT INTO source_fundamentals (ticker, source, field, value, fetched_at)
        VALUES (${ticker}, 'yahoo', 'forwardEps', ${y}, now())
        ON CONFLICT (ticker, source, field) DO UPDATE SET value = excluded.value, fetched_at = now()
      `);
      yahooOk++;
      changed.push(ticker);
    }
    if (fmpUsed >= FMP_CAP) return;
    fmpUsed++;
    let est: Est | null = null;
    try {
      est = matchingYear(await fmpEstimates(ticker, apiKey), y);
    } catch (err) {
      console.log(`fmp fail ${ticker} ${String((err as Error).message ?? err).slice(0, 80)}`);
    }
    if (est == null) return;
    await db.execute(sql`
      INSERT INTO source_fundamentals (ticker, source, field, value, fetched_at)
      VALUES (${ticker}, 'fmp', 'forwardEps', ${est.eps}, now())
      ON CONFLICT (ticker, source, field) DO UPDATE SET value = excluded.value, fetched_at = now()
    `);
    fmpOk++;
    if (y != null) {
      const gap = Math.abs(est.eps - y) / Math.max(y, est.eps);
      if (gap <= AGREE) agree++;
      else disagree++;
      if (ticker === "ADBE") {
        console.log(`ADBE yahoo ${y} fmp ${est.eps} year ${est.date} gap ${(gap * 100).toFixed(1)}%`);
      }
    }
  });

  let peUpdated = 0;
  if (changed.length > 0) {
    const list = sql.join(changed.map(t => sql`${t}`), sql`, `);
    const upd = await db.execute(sql`
      WITH px AS (
        SELECT DISTINCT ON (ticker) ticker, close::float8 AS close
        FROM prices_historical WHERE close > 0
        ORDER BY ticker, date DESC
      ),
      fwd AS (
        SELECT DISTINCT ON (ticker) ticker, value::float8 AS feps
        FROM source_fundamentals
        WHERE field = 'forwardEps'
          AND source IN ('yahoo','fmp','finnhub','alpha_vantage')
          AND value::float8 > 0
          AND ticker IN (${list})
        ORDER BY ticker, fetched_at DESC
      )
      UPDATE ticker_fundamentals f SET
        forward_pe = px.close / fwd.feps,
        forward_peg = CASE WHEN f.eps_growth IS NOT NULL AND f.eps_growth <> 0
          THEN (px.close / fwd.feps) / (f.eps_growth::float8 * 100) ELSE f.forward_peg END
      FROM px, fwd
      WHERE f.ticker = px.ticker AND f.ticker = fwd.ticker
    `);
    peUpdated = upd.rowCount ?? 0;
    await db.execute(sql`
      UPDATE field_provenance fp
      SET winning_source = 'derived', winning_value = f.forward_pe, divergent = false, updated_at = now(), fetched_at = now()
      FROM ticker_fundamentals f
      WHERE fp.ticker = f.ticker AND fp.field = 'forwardPe' AND f.ticker IN (${list}) AND f.forward_pe IS NOT NULL
    `);
  }

  const adbe = await db.execute<{ pe: string; eps: string }>(sql`
    SELECT round(forward_pe::numeric, 2) pe, round(earnings_per_share::numeric, 2) eps
    FROM ticker_fundamentals WHERE ticker = 'ADBE'
  `);
  console.log(JSON.stringify({
    tickers: tickers.length, yahooOk, fmpOk, agree, disagree, peUpdated, adbe: adbe.rows[0],
  }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
