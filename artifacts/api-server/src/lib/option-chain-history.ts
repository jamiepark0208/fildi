/**
 * Daily option chain history (user YES 2026-10-06, research/studies S012).
 *
 * Saves a trimmed copy of the chains the nightly option-score snapshot already fetched — zero extra Schwab/Yahoo calls.
 * Purpose: our own point-in-time chain history so backtests can use real bid/ask instead of Black-Scholes reconstructions.
 * Kept: strikes from 10% ITM through ATM to 35% OTM with a live bid, 1–45 DTE (the chain window). Fields are the ones a backtest needs;
 * greeks beyond delta are recomputable from iv and skipped.
 */
import { logger } from "./logger.js";
import type { OptionRow, OptionsChainResult } from "./options.js";

export const CHAIN_HISTORY_MAX_OTM = 0.35;
/** Negative = ITM. -0.10 keeps ATM + up to 10 % ITM so straddles/ITM structures are testable (Jamie 11-04). */
export const CHAIN_HISTORY_MIN_OTM = -0.10;

export interface ChainHistoryRow {
  asOf: string;
  ticker: string;
  expiry: string;
  side: "put" | "call";
  strike: number;
  dte: number;
  spot: number;
  bid: number;
  ask: number | null;
  last: number | null;
  iv: number | null;
  delta: number | null;
  volume: number | null;
  openInterest: number | null;
  source: string;
}

/** Pure: chains → rows worth keeping (OTM band, live bid). */
export function chainHistoryRows(ticker: string, chains: OptionsChainResult[], asOf: string): ChainHistoryRow[] {
  const out: ChainHistoryRow[] = [];
  for (const c of chains) {
    if (!(c.spot > 0)) continue;
    for (const side of ["put", "call"] as const) {
      for (const r of side === "put" ? c.puts : c.calls) {
        const otm = side === "put" ? (c.spot - r.strike) / c.spot : (r.strike - c.spot) / c.spot;
        if (otm < CHAIN_HISTORY_MIN_OTM || otm > CHAIN_HISTORY_MAX_OTM || !(r.bid > 0) || !r.bidIsLive) continue;
        out.push({
          asOf, ticker: ticker.toUpperCase(), expiry: c.expiry, side, strike: r.strike, dte: c.daysToExpiry, spot: c.spot,
          bid: r.bid, ask: r.ask > 0 ? r.ask : null, last: r.lastPrice > 0 ? r.lastPrice : null,
          iv: r.iv > 0 ? r.iv : null, delta: r.delta, volume: r.volume, openInterest: r.openInterest,
          source: c.source ?? "yahoo",
        });
      }
    }
  }
  return out;
}

const DDL = `
  CREATE TABLE IF NOT EXISTS option_chain_history (
    as_of date NOT NULL, ticker text NOT NULL, expiry date NOT NULL, side text NOT NULL, strike numeric NOT NULL,
    dte integer, spot numeric, bid numeric NOT NULL, ask numeric, last numeric, iv numeric, delta numeric,
    volume integer, open_interest integer, source text, fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (as_of, ticker, expiry, side, strike)
  );
  CREATE INDEX IF NOT EXISTS idx_option_chain_history_ticker ON option_chain_history (ticker, as_of);`;

const COLS = 15;

/** Persist one day's rows (re-runs on the same day overwrite). Never throws: history is a side job of the snapshot. */
export async function persistChainHistory(chainsByTicker: Map<string, OptionsChainResult[]>, asOf: string): Promise<number> {
  try {
    const { pool } = await import("@workspace/db");
    await pool.query(DDL);
    const rows = [...chainsByTicker].flatMap(([t, chains]) => chainHistoryRows(t, chains, asOf));
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const vals: unknown[] = [];
      const ph = batch.map((r, j) => {
        vals.push(r.asOf, r.ticker, r.expiry, r.side, r.strike, r.dte, r.spot, r.bid, r.ask, r.last, r.iv, r.delta,
          r.volume, r.openInterest, r.source);
        return `(${Array.from({ length: COLS }, (_, k) => `$${j * COLS + k + 1}`).join(",")})`;
      });
      await pool.query(
        `INSERT INTO option_chain_history (as_of, ticker, expiry, side, strike, dte, spot, bid, ask, last, iv, delta, volume, open_interest, source)
         VALUES ${ph.join(",")}
         ON CONFLICT (as_of, ticker, expiry, side, strike) DO UPDATE SET bid = EXCLUDED.bid, ask = EXCLUDED.ask,
           last = EXCLUDED.last, iv = EXCLUDED.iv, delta = EXCLUDED.delta, spot = EXCLUDED.spot,
           volume = EXCLUDED.volume, open_interest = EXCLUDED.open_interest, source = EXCLUDED.source, fetched_at = now()`,
        vals,
      );
    }
    logger.info({ asOf, rows: rows.length, tickers: chainsByTicker.size }, "option-chain-history: saved");
    return rows.length;
  } catch (err) {
    logger.warn({ err }, "option-chain-history: save failed");
    return 0;
  }
}

/** Pure: DB-shaped rows → OptionsChainResult map (for closed-market / miss-day reconstruct). */
export function chainsFromHistoryRows(
  rows: Array<{
    ticker: string;
    expiry: string;
    side: string;
    strike: number;
    dte: number | null;
    spot: number;
    bid: number;
    ask: number | null;
    last: number | null;
    iv: number | null;
    delta: number | null;
    volume: number | null;
    openInterest: number | null;
    source: string | null;
  }>,
): Map<string, OptionsChainResult[]> {
  type Acc = Map<string, OptionsChainResult>; // key = expiry
  const byTicker = new Map<string, Acc>();
  for (const r of rows) {
    const t = r.ticker.toUpperCase();
    let byExp = byTicker.get(t);
    if (!byExp) {
      byExp = new Map();
      byTicker.set(t, byExp);
    }
    const exp = r.expiry.slice(0, 10);
    let chain = byExp.get(exp);
    if (!chain) {
      const dte = r.dte ?? 0;
      chain = {
        ticker: t,
        expiry: exp,
        isWeekly: dte <= 9,
        daysToExpiry: dte,
        exactDte: dte,
        settlementDte: dte,
        spot: r.spot,
        tier: 1,
        puts: [],
        calls: [],
        fetchedAt: 0,
        source: r.source === "schwab" || r.source === "yahoo" ? r.source : "yahoo",
      };
      byExp.set(exp, chain);
    }
    const opt: OptionRow = {
      strike: r.strike,
      bid: r.bid,
      ask: r.ask ?? 0,
      lastPrice: r.last ?? 0,
      iv: r.iv ?? 0,
      volume: r.volume,
      openInterest: r.openInterest,
      incomePct: r.strike > 0 ? (r.bid / r.strike) * 100 : 0,
      meetsGate: true,
      bidIsLive: true, // persisted only when live that session
      quoteStale: false,
      delta: r.delta,
      spreadPct: r.ask != null && r.ask > 0 && r.bid > 0 ? (r.ask - r.bid) / ((r.ask + r.bid) / 2) : null,
    };
    if (r.side === "put") chain.puts.push(opt);
    else if (r.side === "call") chain.calls.push(opt);
  }
  return new Map([...byTicker].map(([t, byExp]) => [t, [...byExp.values()]]));
}

/** Load a prior session's live chains (written by option-score / model snapshot). Empty map if none. */
export async function loadChainsFromHistory(
  asOf: string,
  tickers?: string[],
): Promise<Map<string, OptionsChainResult[]>> {
  try {
    const { pool } = await import("@workspace/db");
    const params: unknown[] = [asOf];
    let filter = "";
    if (tickers?.length) {
      params.push(tickers.map((t) => t.toUpperCase()));
      filter = " AND ticker = ANY($2::text[])";
    }
    const { rows } = await pool.query(
      `SELECT ticker, expiry::text, side, strike::float8 AS strike, dte, spot::float8 AS spot,
              bid::float8 AS bid, ask::float8 AS ask, last::float8 AS last, iv::float8 AS iv,
              delta::float8 AS delta, volume, open_interest AS "openInterest", source
       FROM option_chain_history WHERE as_of = $1::date${filter}`,
      params,
    );
    return chainsFromHistoryRows(rows as Parameters<typeof chainsFromHistoryRows>[0]);
  } catch (err) {
    logger.warn({ err, asOf }, "option-chain-history: load failed");
    return new Map();
  }
}
