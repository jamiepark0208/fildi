/**
 * Live Schwab quotes for specific option contracts (OCC symbols) — used by the Robinhood verify step to re-price
 * Fildi's plan at the same moment as the Robinhood quote (user YES 2026-10-06, research/studies S012).
 * Budget: one /quotes call per 50 contracts (a verify run is ~15–30 contracts → 1 call).
 */
import { schwabGet } from "./schwab-client.js";
import { schwabCredentialsConfigured } from "./schwab-auth.js";

export interface OptionContractRef {
  ticker: string;
  expiry: string; // YYYY-MM-DD
  strike: number;
  type: "put" | "call";
}

export interface SchwabOptionQuote {
  bid: number | null;
  ask: number | null;
  mark: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  delta: number | null;
  iv: number | null; // decimal (0.45), Schwab sends percent
  underlying: number | null;
  quoteTime: string | null;
}

/** OCC symbol as Schwab expects it: root padded to 6, YYMMDD, C/P, strike × 1000 padded to 8. */
export function occSymbol(c: OptionContractRef): string {
  const [y, m, d] = c.expiry.split("-");
  const strike = String(Math.round(c.strike * 1000)).padStart(8, "0");
  return `${c.ticker.toUpperCase().padEnd(6, " ")}${y!.slice(2)}${m}${d}${c.type === "put" ? "P" : "C"}${strike}`;
}

const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

interface RawOptionQuote {
  quote?: {
    bidPrice?: number; askPrice?: number; mark?: number; lastPrice?: number; totalVolume?: number; openInterest?: number;
    delta?: number; volatility?: number; underlyingPrice?: number; quoteTime?: number;
  };
}

export function mapOptionQuote(raw: RawOptionQuote | undefined): SchwabOptionQuote | null {
  const q = raw?.quote;
  if (!q) return null;
  const iv = n(q.volatility);
  return {
    bid: n(q.bidPrice), ask: n(q.askPrice), mark: n(q.mark), last: n(q.lastPrice), volume: n(q.totalVolume),
    openInterest: n(q.openInterest), delta: n(q.delta), iv: iv != null && iv > 0 ? iv / 100 : null,
    underlying: n(q.underlyingPrice), quoteTime: n(q.quoteTime) != null ? new Date(q.quoteTime!).toISOString() : null,
  };
}

/** Keyed by OCC symbol. Null when Schwab is not configured or the first call fails. */
export async function getSchwabOptionQuotes(contracts: OptionContractRef[]): Promise<Record<string, SchwabOptionQuote> | null> {
  if (!schwabCredentialsConfigured() || contracts.length === 0) return null;
  const syms = [...new Set(contracts.map(occSymbol))];
  const out: Record<string, SchwabOptionQuote> = {};
  for (let i = 0; i < syms.length; i += 50) {
    const chunk = syms.slice(i, i + 50);
    const data = await schwabGet<Record<string, RawOptionQuote>>("/quotes", { symbols: chunk.join(","), fields: "quote" });
    if (!data) {
      if (i === 0) return null;
      break;
    }
    for (const s of chunk) {
      const q = mapOptionQuote(data[s]);
      if (q) out[s] = q;
    }
  }
  return out;
}
