/**
 * A205 — chains for the Structure Ranker. The stored engine chain (options-chain-store) keeps only the 2–3 nearest
 * expiries and OTM strikes (3–25 %), so ATM straddles and 30-day calendars had no quotes. This merges it with a
 * Schwab ladder (both sides, ATM ± strikeCount, today → horizon + 45 d). Raw payloads land in vendor_raw via
 * schwabGet; the merged result is cached per ticker × window and served stale while it refreshes. Schwab down →
 * stored chain only (the Ranker then reports unquoted structures as `unpriced`).
 */
import type { OptionRow, OptionsChainResult } from "../options.js";
import { getSchwabChainLadder } from "../schwab-client.js";
import { TTLCache } from "../ttl-cache.js";

type LadderRow = NonNullable<Awaited<ReturnType<typeof getSchwabChainLadder>>>["rows"][number];

const LADDER_TTL_MS = 15 * 60 * 1000;   // Ranker is on-demand; a 15-min quote is fine for a model estimate
const LADDER_DEADLINE_MS = 12_000;
const BACK_MONTH_DAYS = 45;              // calendars: back leg ≈ front + 30 d
const STRIKE_COUNT = 40;
export const rankerLadderCache = new TTLCache<LadderRow[] & { spot?: number | null }>(LADDER_TTL_MS, "structures-ladder", 500);

const DAY = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function toRow(r: LadderRow): OptionRow {
  const bid = r.bid ?? 0;
  const ask = r.ask ?? 0;
  const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : 0;
  return {
    strike: r.strike, bid, ask, lastPrice: r.mark ?? mid, iv: r.iv ?? 0, volume: r.volume, openInterest: r.oi,
    incomePct: 0, meetsGate: false, bidIsLive: bid > 0, quoteStale: !(bid > 0), delta: r.delta,
    spreadPct: mid > 0 ? (ask - bid) / mid : null,
  };
}

/** Pure merge: stored rows win per (expiry, side, strike); ladder adds missing strikes and expiries. */
export function mergeLadder(stored: OptionsChainResult[], ladder: LadderRow[], spot: number | null, nowMs = Date.now()): OptionsChainResult[] {
  const byExp = new Map(stored.map((c) => [c.expiry, { ...c, puts: [...c.puts], calls: [...c.calls] }]));
  const base = stored[0];
  const sp = spot && spot > 0 ? spot : base?.spot ?? 0;
  for (const r of ladder) {
    if (!(r.strike > 0) || (!(r.bid ?? 0) && !(r.ask ?? 0))) continue;
    let c = byExp.get(r.expiry);
    if (!c) {
      const end = new Date(`${r.expiry}T16:00:00`).getTime();
      const exact = Math.max(0.5, (end - nowMs) / DAY);
      c = { ticker: base?.ticker ?? "", expiry: r.expiry, isWeekly: false, daysToExpiry: Math.ceil((end - nowMs) / DAY),
        exactDte: exact, settlementDte: exact, spot: sp, tier: base?.tier ?? 1, puts: [], calls: [], fetchedAt: nowMs, source: "schwab" };
      byExp.set(r.expiry, c);
    }
    const list = r.side === "put" ? c.puts : c.calls;
    if (!list.some((x) => Math.abs(x.strike - r.strike) < 1e-6)) list.push(toRow(r));
  }
  return [...byExp.values()]
    .map((c) => ({ ...c, puts: c.puts.sort((a, b) => a.strike - b.strike), calls: c.calls.sort((a, b) => a.strike - b.strike) }))
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry);
}

async function fetchLadder(ticker: string, from: string, to: string): Promise<LadderRow[] & { spot?: number | null }> {
  const deadline = new Promise<null>((res) => setTimeout(() => res(null), LADDER_DEADLINE_MS));
  const out = await Promise.race([getSchwabChainLadder(ticker, from, to, STRIKE_COUNT), deadline]);
  if (!out?.rows.length) throw new Error(`schwab ladder ${ticker}: empty`);
  return Object.assign(out.rows, { spot: out.spot });
}

/** Stored chain + cached ladder for the Ranker. Never throws; `filled` = the ladder was merged in. */
export async function rankerChains(ticker: string, stored: OptionsChainResult[], horizonDays: number):
  Promise<{ chains: OptionsChainResult[]; filled: boolean }> {
  const now = Date.now();
  const from = ymd(now);
  const to = ymd(now + (Math.min(horizonDays, 180) + BACK_MONTH_DAYS) * DAY);
  try {
    const ladder = await rankerLadderCache.getOrComputeStale(`${ticker}|${from}|${to}`, () => fetchLadder(ticker, from, to));
    return { chains: mergeLadder(stored, ladder, ladder.spot ?? null, now), filled: true };
  } catch {
    return { chains: stored, filled: false };
  }
}
