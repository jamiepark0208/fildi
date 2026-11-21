/**
 * Trade ticket repricing — live bid/ask/IV per leg from the same chains the structure pricer uses
 * (stored chain + Schwab ATM/back-month ladder via rankerChains). Pure picker here; I/O in routes/options.ts.
 */
import type { OptionsChainResult } from "../options.js";

export interface QuoteReq { ticker: string; kind: "call" | "put" | "stock"; strike?: number; expiry?: string }
export interface LegQuote {
  bid: number | null; ask: number | null; iv: number | null; spot: number | null;
  /** false = no row for this strike/expiry (or no two-sided market). */
  quoted: boolean;
  reason?: string;
}

const TICKER_RE = /^[A-Z.]{1,10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Drops malformed legs; caps the list (fan-out guard). */
export function cleanQuoteReqs(raw: unknown, max = 40): QuoteReq[] {
  if (!Array.isArray(raw)) return [];
  const out: QuoteReq[] = [];
  for (const r of raw.slice(0, max)) {
    const t = String((r as QuoteReq)?.ticker ?? "").toUpperCase();
    const kind = (r as QuoteReq)?.kind;
    if (!TICKER_RE.test(t) || !["call", "put", "stock"].includes(kind)) continue;
    if (kind === "stock") { out.push({ ticker: t, kind }); continue; }
    const strike = Number((r as QuoteReq).strike), expiry = String((r as QuoteReq).expiry ?? "");
    if (!(strike > 0) || !DATE_RE.test(expiry)) continue;
    out.push({ ticker: t, kind, strike, expiry });
  }
  return out;
}

/** Quote one leg from chains. spot = caller's live price (one spot per name across legs), else the chain's. */
export function quoteFromChains(chains: OptionsChainResult[], q: QuoteReq, spot: number | null): LegQuote {
  const px = spot ?? chains[0]?.spot ?? null;
  if (q.kind === "stock") return { bid: px, ask: px, iv: null, spot: px, quoted: px != null && px > 0 };
  const chain = chains.find((c) => c.expiry === q.expiry);
  if (!chain) return { bid: null, ask: null, iv: null, spot: px, quoted: false, reason: "expiry not listed" };
  const rows = q.kind === "call" ? chain.calls : chain.puts;
  const row = rows.find((r) => Math.abs(r.strike - (q.strike ?? 0)) < 1e-6);
  if (!row) return { bid: null, ask: null, iv: null, spot: px ?? chain.spot, quoted: false, reason: "strike not listed" };
  const bid = row.bid > 0 ? row.bid : null;
  const ask = row.ask > 0 && row.ask >= row.bid ? row.ask : null;
  return {
    bid, ask, iv: row.iv > 0 ? row.iv : null, spot: px ?? chain.spot,
    quoted: bid != null || ask != null,
    reason: bid == null && ask == null ? "no market" : undefined,
  };
}
