/**
 * Daily option chain history (user YES 2026-10-06, research/studies S012).
 *
 * Saves a trimmed copy of the chains the nightly option-score snapshot already fetched — zero extra Schwab/Yahoo calls.
 * Purpose: our own point-in-time chain history so backtests can use real bid/ask instead of Black-Scholes reconstructions.
 * Kept: OTM strikes 1–35% from spot with a live bid, 1–45 DTE (the chain window). Fields are the ones a backtest needs;
 * greeks beyond delta are recomputable from iv and skipped.
 */
import { logger } from "./logger.js";
import type { OptionsChainResult } from "./options.js";

export const CHAIN_HISTORY_MAX_OTM = 0.35;
export const CHAIN_HISTORY_MIN_OTM = 0.01;

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
