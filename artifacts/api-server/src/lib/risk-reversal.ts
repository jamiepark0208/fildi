/**
 * Jamie 11-18: "sell OTM puts to earn income, use that income to buy long OTM calls" — a put-funded call (risk reversal,
 * expiries may differ). Pure pairing logic; the route feeds it a merged chain (stored + Schwab ladder) and daily bars.
 *
 * Evidence behind the defaults (research/studies/INDEX.md):
 *  - S178: on 548k real LSEG quotes single-name calls have no wing (IV ≈ ATM at every Δ) while OTM puts carry +6–20 %
 *    → the put is the rich side to sell, the call is fairly priced to buy. Panic RR (−0.25Δ P / +0.50Δ C, 30 DTE)
 *    +6 %/$ strike vs put alone +2.3 %, 11/15 panic Mondays; losers = early panic weeks (UNDERPOWERED, 15 episodes).
 *  - S198: on crashed names longer (≈ 6 m) 1.0–1.2× strike calls paid +46–91 %/premium (survivorship-flattered);
 *    1-month calls 7–26 % to breakeven. S178: longer is not better per unit time → offer the 3–6 m window, not LEAPS.
 *  - 11-17 tenor-cost: with the VIX curve inverted, 6 m IV ≤ 3 m on 9/11 holdings → back-month calls are cheap per day,
 *    front-month puts are rich → short put 25–65 DTE, long call 85–190 DTE.
 *  - Fills: RH realistic fill = bid + ~23 % of the spread (sell) / ask − ~23 % (buy) (state.md open facts).
 */
import type { OptionRow, OptionsChainResult } from "./options.js";
import { normCDF } from "./options-greeks.js";

export const RR_PARAMS = {
  putDte: [14, 45] as const,   // 11-18 surface: same-expiry RR25 6–8 vol pts at 10–31 DTE vs 1–2 at 120–150 → sell the front
  callDte: [85, 190] as const,
  putAbsDelta: [0.1, 0.35] as const,
  callDelta: [0.2, 0.6] as const,
  fillFrac: 0.23,
  maxSpreadPct: 0.35,     // skip legs whose bid-ask is > 35 % of mid (unfillable)
  swingBars: 5,           // swing low/high = extreme of ±5 daily bars
  clusterPct: 0.02,       // merge levels within 2 %
};

export type Bar = { date: string; high: number; low: number; close: number };
export type Level = { price: number; kind: "swing" | "52w" | "sma50" | "sma200"; date?: string };

/** Support (below spot) and resistance (above spot) from 1 y of daily bars: swing extremes, 52-w low/high, 50/200-d SMA. */
export function levelsFromBars(bars: Bar[], spot: number, p = RR_PARAMS): { support: Level[]; resistance: Level[] } {
  const b = bars.slice(-252);
  const raw: Level[] = [];
  const k = p.swingBars;
  for (let i = k; i < b.length - k; i++) {
    const win = b.slice(i - k, i + k + 1);
    if (b[i].low === Math.min(...win.map((x) => x.low))) raw.push({ price: b[i].low, kind: "swing", date: b[i].date });
    if (b[i].high === Math.max(...win.map((x) => x.high))) raw.push({ price: b[i].high, kind: "swing", date: b[i].date });
  }
  if (b.length) {
    raw.push({ price: Math.min(...b.map((x) => x.low)), kind: "52w" }, { price: Math.max(...b.map((x) => x.high)), kind: "52w" });
  }
  const sma = (n: number) => (b.length >= n ? b.slice(-n).reduce((s, x) => s + x.close, 0) / n : null);
  const s50 = sma(50), s200 = sma(200);
  if (s50) raw.push({ price: s50, kind: "sma50" });
  if (s200) raw.push({ price: s200, kind: "sma200" });
  const cluster = (xs: Level[], asc: boolean) => {
    const s = [...xs].sort((a, c) => (asc ? a.price - c.price : c.price - a.price));
    const out: Level[] = [];
    for (const x of s) {
      const last = out[out.length - 1];
      if (last && Math.abs(x.price / last.price - 1) <= p.clusterPct) continue; // keep the one nearest spot
      out.push(x);
    }
    return out;
  };
  // nearest first: support descending from spot, resistance ascending from spot
  return {
    support: cluster(raw.filter((x) => x.price < spot * 0.99), false),
    resistance: cluster(raw.filter((x) => x.price > spot * 1.01), true),
  };
}

const sellFill = (r: OptionRow, f: number) => r.bid + f * (r.ask - r.bid);
const buyFill = (r: OptionRow, f: number) => r.ask - f * (r.ask - r.bid);
const quoted = (r: OptionRow, p: typeof RR_PARAMS) =>
  r.bid > 0 && r.ask > r.bid && r.iv > 0.05 && r.iv < 5 && (r.ask - r.bid) / ((r.ask + r.bid) / 2) <= p.maxSpreadPct;

/** Black-Scholes delta (r = 0) when the vendor row has none. */
function deltaOf(r: OptionRow, spot: number, dte: number, side: "put" | "call"): number {
  if (r.delta != null) return r.delta;
  const sd = r.iv * Math.sqrt(dte / 365);
  const d1 = (Math.log(spot / r.strike) + 0.5 * sd * sd) / sd;
  return side === "call" ? normCDF(d1) : normCDF(d1) - 1;
}
/** IV at a target delta on one expiry (linear in Δ between the two bracketing quoted strikes). */
export function ivAtDelta(rows: OptionRow[], target: number): number | null {
  const ok = rows.filter((r) => r.delta != null && r.iv > 0.05 && r.iv < 5 && r.bid > 0).sort((a, b) => a.delta! - b.delta!);
  for (let i = 0; i + 1 < ok.length; i++) {
    const a = ok[i], b = ok[i + 1];
    if (a.delta !== b.delta && (a.delta! - target) * (b.delta! - target) <= 0)
      return a.iv + ((b.iv - a.iv) * (target - a.delta!)) / (b.delta! - a.delta!);
  }
  return null;
}
/** Front-month skew on the expiry in 7–45 DTE nearest 30 — same definition as scripts/watchlist_sync/rr_skew.py
 *  (rr_skew_daily history), so a live value ranks against stored days. */
export function frontSkew(chains: OptionsChainResult[]): { expiry: string; dte: number; rr25: number; p25: number; c25: number; atm: number | null } | null {
  const c = chains.filter((x) => x.daysToExpiry >= 7 && x.daysToExpiry <= 45)
    .sort((a, b) => Math.abs(a.daysToExpiry - 30) - Math.abs(b.daysToExpiry - 30));
  for (const ch of c) {
    const p25 = ivAtDelta(ch.puts, -0.25), c25 = ivAtDelta(ch.calls, 0.25);
    if (p25 == null || c25 == null) continue;
    const ap = ivAtDelta(ch.puts, -0.5), ac = ivAtDelta(ch.calls, 0.5);
    const atm = ap != null && ac != null ? (ap + ac) / 2 : (ap ?? ac);
    return { expiry: ch.expiry, dte: ch.daysToExpiry, rr25: p25 - c25, p25, c25, atm };
  }
  return null;
}
/** P(S_T > x), lognormal at the leg's own IV, no drift (market-implied). */
const pAbove = (spot: number, x: number, iv: number, dte: number) => {
  const sd = iv * Math.sqrt(dte / 365);
  return 1 - normCDF((Math.log(x / spot) + 0.5 * sd * sd) / sd);
};
function atmIv(c: OptionsChainResult, spot: number): number | null {
  const rows = [...c.calls, ...c.puts].filter((r) => r.iv > 0.05 && r.iv < 5);
  if (!rows.length) return null;
  const m = Math.min(...rows.map((r) => Math.abs(r.strike - spot)));
  const near = rows.filter((r) => Math.abs(r.strike - spot) === m);
  return near.reduce((s, r) => s + r.iv, 0) / near.length;
}

export type Direction = "bull" | "bear";
export type RRLeg = { side: "put" | "call"; expiry: string; dte: number; strike: number; bid: number; ask: number; fill: number; iv: number; delta: number };
export type RRPair = {
  direction: Direction;
  /** bull: short put at support + long call to resistance · bear: short call at resistance + long put to support */
  short: RRLeg; long: RRLeg; spot: number;
  /** + = credit to you, − = you pay (per share; ×100 per pair) */
  net: number;
  anchor: Level | null;   // level the short strike sits behind (support for bull, resistance for bear)
  target: Level | null;   // level the long strike aims at (≥ ±10 % away)
  /** Same-expiry skew (Jamie 11-18: skew is per expiry, never one date ÷ another). */
  shortSkew: number | null;    // short-leg IV ÷ ATM IV, short expiry
  longSkew: number | null;     // long-leg IV ÷ ATM IV, long expiry
  rr25Short: number | null;    // 25Δ put IV − 25Δ call IV on the short expiry (+ = puts rich, − = calls rich)
  rr25Long: number | null;     // same on the long expiry
  term: number | null;         // ATM IV long expiry ÷ ATM IV short expiry (< 1 = back month cheap)
  volEdge: number;             // IV sold − IV bought (skew + term together)
  rollsToFund: number;         // long cost ÷ one short credit
  rollsAvailable: number;      // short cycles that fit before the long leg expires
  pShortSafe: number;          // P(short leg expires OTM)
  pLongItm: number;            // P(long leg ends ITM)
  pLongBe: number;             // P(long leg ends past strike ∓ net debit)
  /** bull: strike × 100 (cash-secured) · bear: null = uncapped unless you own 100 shares */
  cashIfAssigned: number | null;
  assignedBasis: number | null;
  longMoveToStrike: number;    // signed move to the long strike
};

/**
 * Short leg for either mode: 14–45 DTE, strike at/behind the nearest anchor level (support for bull, resistance for bear),
 * |Δ| in band; the expiry selling the most IV wins (≥ 1 pt to leave ~30 DTE). `maxExpiry` = never outlive a leg it funds.
 */
export function pickShortLeg(chains: OptionsChainResult[], spot: number, lv: { support: Level[]; resistance: Level[] },
  p = RR_PARAMS, direction: Direction = "bull", maxExpiry?: string): { short: RRLeg; chain: OptionsChainResult; anchor: Level | null } | null {
  const f = p.fillFrac;
  const bull = direction === "bull";
  const shortSide: "put" | "call" = bull ? "put" : "call";
  const rowsOf = (c: OptionsChainResult, side: "put" | "call") => (side === "put" ? c.puts : c.calls);
  const otm = (k: number, side: "put" | "call") => (side === "put" ? k < spot : k > spot);
  const absD = (r: OptionRow, dte: number, side: "put" | "call") => Math.abs(deltaOf(r, spot, dte, side));
  const anchor = bull ? (lv.support.find((x) => x.price <= spot * 0.97) ?? lv.support[0] ?? null)
    : (lv.resistance.find((x) => x.price >= spot * 1.03) ?? lv.resistance[0] ?? null);
  const behind = (k: number) => (anchor ? (bull ? k <= anchor.price : k >= anchor.price) : false);
  let short: RRLeg | null = null, shortChain: OptionsChainResult | null = null;
  const shortExp = chains.filter((c) => c.daysToExpiry >= p.putDte[0] && c.daysToExpiry <= p.putDte[1] && (!maxExpiry || c.expiry <= maxExpiry))
    .sort((a, b) => Math.abs(a.daysToExpiry - 30) - Math.abs(b.daysToExpiry - 30));
  for (const c of shortExp) {
    const ok = rowsOf(c, shortSide).filter((r) => otm(r.strike, shortSide) && quoted(r, p))
      .map((r) => ({ r, d: absD(r, c.daysToExpiry, shortSide) }))
      .filter((x) => x.d >= p.putAbsDelta[0] && x.d <= p.putAbsDelta[1]);
    if (!ok.length) continue;
    const at = ok.filter((x) => behind(x.r.strike));
    // nearest strike behind the anchor; none in the Δ band → nearest 0.25Δ (S178 RR leg)
    const chosen = at.length ? at.sort((a, b) => (bull ? b.r.strike - a.r.strike : a.r.strike - b.r.strike))[0]
      : ok.sort((a, b) => Math.abs(a.d - 0.25) - Math.abs(b.d - 0.25))[0];
    if (!short || chosen.r.iv > short.iv + 0.01) {
      short = { side: shortSide, expiry: c.expiry, dte: c.daysToExpiry, strike: chosen.r.strike, bid: chosen.r.bid, ask: chosen.r.ask,
        fill: sellFill(chosen.r, f), iv: chosen.r.iv, delta: deltaOf(chosen.r, spot, c.daysToExpiry, shortSide) };
      shortChain = c;
    }
  }
  if (!short || !shortChain) return null;
  return { short, chain: shortChain, anchor };
}

/**
 * One engine, both directions (Jamie 11-18: "dynamic and applicable for the opposite bearish risk reversals").
 * Short leg: 14–45 DTE, strike at/behind the nearest anchor level (support for bull, resistance for bear), |Δ| in band;
 * the expiry that sells the most IV wins (≥ 1 pt to leave ~30 DTE). Long leg: 85–190 DTE, strike between spot and the
 * first level ≥ 10 % away, cost matched to one short credit; longest expiry within 10 % of even, else smallest debit.
 */
export function pickRiskReversal(chains: OptionsChainResult[], spot: number, lv: { support: Level[]; resistance: Level[] },
  p = RR_PARAMS, direction: Direction = "bull"): RRPair | null {
  const f = p.fillFrac;
  const bull = direction === "bull";
  const longSide: "put" | "call" = bull ? "call" : "put";
  const rowsOf = (c: OptionsChainResult, side: "put" | "call") => (side === "put" ? c.puts : c.calls);
  const absD = (r: OptionRow, dte: number, side: "put" | "call") => Math.abs(deltaOf(r, spot, dte, side));

  const picked = pickShortLeg(chains, spot, lv, p, direction);
  if (!picked) return null;
  const { short, chain: shortChain, anchor } = picked;

  // Target = first level ≥ 10 % away (a minor swing 1–3 % away forces a near-ATM long leg costing 2–3× the credit).
  const target = bull ? (lv.resistance.find((x) => x.price >= spot * 1.1) ?? null) : (lv.support.find((x) => x.price <= spot * 0.9) ?? null);
  const cap = target ? target.price : bull ? spot * 1.3 : spot * 0.7;
  const inRange = (k: number) => (bull ? k > spot && k <= cap : k < spot && k >= cap);
  const best: { leg: RRLeg; net: number }[] = [];
  for (const c of chains.filter((x) => x.daysToExpiry >= p.callDte[0] && x.daysToExpiry <= p.callDte[1])) {
    const ok = rowsOf(c, longSide).filter((r) => inRange(r.strike) && quoted(r, p))
      .map((r) => ({ r, d: absD(r, c.daysToExpiry, longSide) }))
      .filter((x) => x.d >= p.callDelta[0] && x.d <= p.callDelta[1]);
    if (!ok.length) continue;
    const s = ok.map((x) => ({ x, net: short!.fill - buyFill(x.r, f) })).sort((a, b) => Math.abs(a.net) - Math.abs(b.net))[0];
    best.push({ leg: { side: longSide, expiry: c.expiry, dte: c.daysToExpiry, strike: s.x.r.strike, bid: s.x.r.bid, ask: s.x.r.ask,
      fill: buyFill(s.x.r, f), iv: s.x.r.iv, delta: deltaOf(s.x.r, spot, c.daysToExpiry, longSide) }, net: s.net });
  }
  if (!best.length) return null;
  const tol = 0.1 * short.fill;
  const choice = best.filter((b) => b.net >= -tol).sort((a, b) => b.leg.dte - a.leg.dte)[0] ?? best.sort((a, b) => b.net - a.net)[0];
  const long = choice.leg;
  const longChain = chains.find((c) => c.expiry === long.expiry)!;
  const atmS = atmIv(shortChain, spot), atmL = atmIv(longChain, spot);
  const rr = (c: OptionsChainResult) => {
    const p25 = ivAtDelta(c.puts, -0.25), c25 = ivAtDelta(c.calls, 0.25);
    return p25 != null && c25 != null ? p25 - c25 : null;
  };
  const debit = Math.max(0, -choice.net);
  const pS = pAbove(spot, short.strike, short.iv, short.dte);
  const pL = pAbove(spot, long.strike, long.iv, long.dte);
  const pLbe = pAbove(spot, bull ? long.strike + debit : long.strike - debit, long.iv, long.dte);
  return {
    direction, short, long, spot, net: choice.net, anchor, target,
    shortSkew: atmS ? short.iv / atmS : null, longSkew: atmL ? long.iv / atmL : null,
    rr25Short: rr(shortChain), rr25Long: rr(longChain), term: atmS && atmL ? atmL / atmS : null,
    volEdge: short.iv - long.iv,
    rollsToFund: long.fill / short.fill, rollsAvailable: Math.max(1, Math.floor(long.dte / short.dte)),
    pShortSafe: bull ? pS : 1 - pS, pLongItm: bull ? pL : 1 - pL, pLongBe: bull ? pLbe : 1 - pLbe,
    cashIfAssigned: bull ? short.strike * 100 : null, assignedBasis: bull ? short.strike - short.fill : null,
    longMoveToStrike: long.strike / spot - 1,
  };
}

/** A long call you already hold (RH snapshot, per-share cost / mark). */
export type HeldCall = { strike: number; expiry: string; days: number; qty: number; cost: number; mark: number | null };
export type FundingPut = {
  short: RRLeg; anchor: Level | null; spot: number;
  credit: number;            // $ for qty puts (1 put per call, 100 sh each)
  paid: number; valueLeft: number | null;
  coverPaid: number;         // one credit ÷ what you paid (1 = this put alone pays the call back)
  coverLeft: number | null;  // one credit ÷ the call's mark today
  rollsToCover: number;      // puts needed to recover what you paid
  rollsAvailable: number;    // put cycles that fit before the call expires
  breakeven: number; breakevenAfter: number;   // call breakeven now vs after this put expires worthless
  pBe: number | null; pBeAfter: number | null; // P(call ends past breakeven) before / after (IV lognormal, no drift)
  pShortSafe: number; cashIfAssigned: number; assignedBasis: number;
  /** Lower-collateral version (Jamie 11-19 "easier for lower cash collateral"): same short put + a lower bought put.
   * Collateral = width × 100 × qty − credit; picked = smallest collateral that keeps ≥ 50 % of the plain put's credit. */
  spread: { longStrike: number; longFill: number; credit: number; collateral: number; maxLoss: number; keepPct: number } | null;
};

/**
 * Step 3 (Jamie 11-18 "fund an existing long call"): one short put per held call, same name, 14–45 DTE at/behind support,
 * expiring on or before the call. Credit lowers the call's breakeven only if the put expires OTM; assigned = you own
 * 100 sh per put at strike − credit while still holding the call (doubles the bet — shown, never hidden).
 */
export function pickFundingPut(chains: OptionsChainResult[], spot: number, lv: { support: Level[]; resistance: Level[] },
  call: HeldCall, callIv: number | null, p = RR_PARAMS): FundingPut | null {
  const picked = pickShortLeg(chains, spot, lv, p, "bull", call.expiry);
  if (!picked) return null;
  const { short, anchor, chain } = picked;
  const f = p.fillFrac;
  let spread: FundingPut["spread"] = null;
  for (const r of chain.puts.filter((x) => x.strike < short.strike && quoted(x, p)).sort((a, b) => b.strike - a.strike)) {
    const net = short.fill - buyFill(r, f);
    if (net < 0.5 * short.fill) continue;            // keeps ≥ half the credit; nearest such strike = least collateral
    const width = short.strike - r.strike;
    spread = { longStrike: r.strike, longFill: buyFill(r, f), credit: net * 100 * call.qty,
      collateral: (width - net) * 100 * call.qty, maxLoss: (width - net) * 100 * call.qty, keepPct: net / short.fill };
    break;
  }
  const credit = short.fill * 100 * call.qty, paid = call.cost * 100 * call.qty;
  const valueLeft = call.mark != null ? call.mark * 100 * call.qty : null;
  const be = call.strike + call.cost, beAfter = be - short.fill;
  const iv = callIv != null && callIv > 0.05 && callIv < 5 ? callIv : null;
  return {
    short, anchor, spot, credit, paid, valueLeft,
    coverPaid: paid > 0 ? credit / paid : 0, coverLeft: valueLeft && valueLeft > 0 ? credit / valueLeft : null,
    rollsToCover: short.fill > 0 ? call.cost / short.fill : Infinity,
    rollsAvailable: Math.max(1, Math.floor(call.days / Math.max(1, short.dte))),
    breakeven: be, breakevenAfter: beAfter,
    pBe: iv ? pAbove(spot, be, iv, call.days) : null, pBeAfter: iv ? pAbove(spot, beAfter, iv, call.days) : null,
    pShortSafe: pAbove(spot, short.strike, short.iv, short.dte),
    cashIfAssigned: short.strike * 100 * call.qty, assignedBasis: short.strike - short.fill, spread,
  };
}
