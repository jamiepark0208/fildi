/**
 * A311 — daily dealer gamma (GEX) from Schwab chains → watchlist_sync.gex_daily.
 */
import { bsGreeks } from "./options-greeks.js";
import { lastCompletedSessionYmd, etDateKey } from "./market-hours.js";
import { logger } from "./logger.js";
import {
  computeGexByStrike,
  computeGexSummary,
  type GexContract,
  type GexStrikeRow,
  type GexSummary,
} from "./gex-daily-math.js";
export { computeGexSummary, contractGexDollars, type GexContract, type GexSummary } from "./gex-daily-math.js";
import {
  normalizeSchwabIv,
  parseExpKey,
  schwabGet,
  type SchwabChainResponse,
} from "./schwab-client.js";
import { schwabCredentialsConfigured } from "./schwab-auth.js";

const RISK_FREE = 0.045;
const CHAIN_DEADLINE_MS = 15_000;
const GEX_MAX_DTE = 60;
const GEX_TICKERS = ["SPY", "QQQ"] as const;

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dteFromAsOf(asOf: string, expiry: string): number {
  const a = new Date(`${asOf}T12:00:00Z`).getTime();
  const e = new Date(`${expiry}T12:00:00Z`).getTime();
  return Math.round((e - a) / 86_400_000);
}

function gammaForLeg(spot: number, strike: number, dte: number, iv: number, isCall: boolean): number {
  const T = Math.max(dte, 1) / 365;
  const sigma = iv > 0 ? iv : 0.2;
  return bsGreeks(spot, strike, T, RISK_FREE, sigma, isCall).gamma;
}

export function contractsFromSchwabChain(raw: SchwabChainResponse, asOf: string, maxDte = GEX_MAX_DTE): {
  spot: number;
  contracts: GexContract[];
} {
  const spot = num(raw.underlyingPrice) ?? num(raw.underlying?.quote?.lastPrice) ?? 0;
  if (!(spot > 0)) return { spot: 0, contracts: [] };

  const contracts: GexContract[] = [];
  for (const [side, map] of [["call", raw.callExpDateMap], ["put", raw.putExpDateMap]] as const) {
    for (const [expKey, strikes] of Object.entries(map ?? {})) {
      const parsed = parseExpKey(expKey);
      const expiry = parsed ? parsed.date.toISOString().slice(0, 10) : expKey.split(":")[0]!;
      const dte = dteFromAsOf(asOf, expiry);
      if (dte < 0 || dte > maxDte) continue;
      for (const list of Object.values(strikes ?? {})) {
        const c = list?.[0];
        if (!c) continue;
        const strike = num(c.strikePrice);
        const oi = num(c.openInterest);
        if (strike == null || !(oi != null && oi > 0)) continue;
        const iv = normalizeSchwabIv(c.volatility);
        const gamma = gammaForLeg(spot, strike, dte, iv, side === "call");
        if (!(gamma > 0)) continue;
        contracts.push({ strike, side, gamma, openInterest: oi, iv, dte });
      }
    }
  }
  return { spot, contracts };
}

const DDL = `
  CREATE SCHEMA IF NOT EXISTS watchlist_sync;
  CREATE TABLE IF NOT EXISTS watchlist_sync.gex_daily (
    as_of date NOT NULL,
    ticker text NOT NULL,
    spot numeric,
    net_gex numeric,
    call_gex numeric,
    put_gex numeric,
    gamma_flip numeric,
    call_wall numeric,
    put_wall numeric,
    n_contracts integer,
    source text NOT NULL DEFAULT 'schwab',
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (as_of, ticker)
  );`;

let authSkipLogged = false;

async function fetchChainWithDeadline(ticker: string, fromDate: string, toDate: string): Promise<SchwabChainResponse | null> {
  return Promise.race([
    schwabGet<SchwabChainResponse>("/chains", {
      symbol: ticker.toUpperCase(),
      contractType: "ALL",
      includeUnderlyingQuote: "true",
      fromDate,
      toDate,
      strikeCount: "200",
    }),
    new Promise<null>((done) => setTimeout(() => done(null), CHAIN_DEADLINE_MS).unref()),
  ]);
}

export async function fetchAndSummarizeGex(ticker: string, asOf = lastCompletedSessionYmd()): Promise<GexSummary | null> {
  if (!schwabCredentialsConfigured()) {
    if (!authSkipLogged) {
      authSkipLogged = true;
      logger.warn("gex-daily: Schwab auth not configured — skip");
    }
    return null;
  }
  const chainFrom = etDateKey() >= asOf ? etDateKey() : asOf;
  const fromDate = chainFrom;
  const toDate = addDaysYmd(chainFrom, GEX_MAX_DTE);
  const raw = await fetchChainWithDeadline(ticker, fromDate, toDate);
  if (!raw) {
    logger.warn({ ticker, asOf }, "gex-daily: chain fetch failed or timed out");
    return null;
  }
  try {
    const { rememberVendorPayload } = await import("./vendor-raw.js");
    await rememberVendorPayload({
      source: "schwab",
      endpoint: "/chains",
      key: `${ticker.toUpperCase()}:gex-daily`,
      payload: raw,
    });
  } catch (err) {
    logger.warn({ ticker, err: String(err) }, "gex-daily: vendor_raw store failed");
  }
  const { spot, contracts } = contractsFromSchwabChain(raw, asOf);
  if (!contracts.length) {
    logger.warn({ ticker, asOf, spot }, "gex-daily: no contracts in window");
    return null;
  }
  return computeGexSummary(contracts, spot);
}

export async function persistGexDaily(ticker: string, asOf: string, summary: GexSummary, source = "schwab"): Promise<void> {
  const { pool } = await import("@workspace/db");
  await pool.query(DDL);
  await pool.query(
    `INSERT INTO watchlist_sync.gex_daily
      (as_of, ticker, spot, net_gex, call_gex, put_gex, gamma_flip, call_wall, put_wall, n_contracts, source)
     VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (as_of, ticker) DO UPDATE SET
       spot = EXCLUDED.spot, net_gex = EXCLUDED.net_gex, call_gex = EXCLUDED.call_gex,
       put_gex = EXCLUDED.put_gex, gamma_flip = EXCLUDED.gamma_flip, call_wall = EXCLUDED.call_wall,
       put_wall = EXCLUDED.put_wall, n_contracts = EXCLUDED.n_contracts, source = EXCLUDED.source,
       fetched_at = now()`,
    [
      asOf,
      ticker.toUpperCase(),
      summary.spot,
      summary.netGex,
      summary.callGex,
      summary.putGex,
      summary.gammaFlip,
      summary.callWall,
      summary.putWall,
      summary.nContracts,
      source,
    ],
  );
}

export async function runGexDailySnapshot(asOf = lastCompletedSessionYmd()): Promise<Array<{ ticker: string; summary: GexSummary }>> {
  const etToday = etDateKey();
  if (etToday > asOf) {
    const { pool } = await import("@workspace/db");
    await pool.query(
      `UPDATE watchlist_sync.gex_daily SET as_of = $1::date WHERE as_of = $2::date AND ticker = ANY($3::text[])`,
      [asOf, etToday, [...GEX_TICKERS]],
    );
  }
  const out: Array<{ ticker: string; summary: GexSummary }> = [];
  for (const ticker of GEX_TICKERS) {
    const summary = await fetchAndSummarizeGex(ticker, asOf);
    if (!summary) continue;
    await persistGexDaily(ticker, asOf, summary);
    out.push({ ticker, summary });
  }
  return out;
}

export { GEX_TICKERS };

export interface GexProfile {
  ticker: string;
  asOf: string;
  maxDte: number;
  summary: GexSummary;
  strikes: GexStrikeRow[];
  fetchedAt: string;
}

/** North-star #7 — live GEX by strike for any optionable ticker (Schwab chain, ≤ 60 DTE, 15 s deadline). null = no auth / no chain. */
export async function fetchGexProfile(ticker: string): Promise<GexProfile | null> {
  if (!schwabCredentialsConfigured()) return null;
  const today = etDateKey();
  const raw = await fetchChainWithDeadline(ticker, today, addDaysYmd(today, GEX_MAX_DTE));
  if (!raw) return null;
  const { spot, contracts } = contractsFromSchwabChain(raw, today);
  if (!contracts.length) return null;
  return {
    ticker: ticker.toUpperCase(),
    asOf: today,
    maxDte: GEX_MAX_DTE,
    summary: computeGexSummary(contracts, spot),
    strikes: computeGexByStrike(contracts, spot),
    fetchedAt: new Date().toISOString(),
  };
}
