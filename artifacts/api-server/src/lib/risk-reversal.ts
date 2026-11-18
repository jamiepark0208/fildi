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

export type RRLeg = { expiry: string; dte: number; strike: number; bid: number; ask: number; fill: number; iv: number; delta: number };
export type RRPair = {
  put: RRLeg; call: RRLeg; spot: number;
  /** + = credit to you, − = you pay (per share; ×100 per pair) */
  net: number;
  support: Level | null; resistance: Level | null;
  /** Same-expiry skew (Jamie 11-18: skew is per expiry, never put-at-one-date ÷ call-at-another). */
  putSkew: number | null;      // put IV ÷ ATM IV, put's expiry
  callSkew: number | null;     // call IV ÷ ATM IV, call's expiry
  rr25Put: number | null;      // 25Δ put IV − 25Δ call IV (vol pts ÷ 100), put's expiry
  rr25Call: number | null;     // same, call's expiry
  term: number | null;         // ATM IV call expiry ÷ ATM IV put expiry (< 1 = inverted: back month cheap)
  /** Vol sold − vol bought (the cross-expiry edge the structure harvests = skew + term). */
  volEdge: number;
  putOverCall: number;
  /** Call cost ÷ one put credit, and how many put cycles fit before the call expires. */
  rollsToFund: number;
  rollsAvailable: number;
  pPutSafe: number;        // P(put expires OTM)
  pCallItm: number;        // P(call ends above its strike)
  pCallBe: number;         // P(call ends above strike + any net debit)
  cashIfAssigned: number;  // strike × 100
  assignedBasis: number;   // strike − put credit
  callMoveToStrike: number;
};

/**
 * Pick the pair: put = highest-strike quoted put at/below the nearest support (|Δ| in band, 25–65 DTE, nearest 45 DTE);
 * call = for each 85–190 DTE expiry, strike between spot and the first resistance (Δ band) whose cost best matches the
 * put credit; prefer the longest expiry within 10 % of zero net, else the smallest debit.
 */
export function pickRiskReversal(chains: OptionsChainResult[], spot: number, lv: { support: Level[]; resistance: Level[] },
  p = RR_PARAMS): RRPair | null {
  const f = p.fillFrac;
  const putExp = chains.filter((c) => c.daysToExpiry >= p.putDte[0] && c.daysToExpiry <= p.putDte[1])
    .sort((a, b) => Math.abs(a.daysToExpiry - 30) - Math.abs(b.daysToExpiry - 30));
  const sup = lv.support.find((x) => x.price <= spot * 0.97) ?? lv.support[0] ?? null;
  let put: RRLeg | null = null, putChain: OptionsChainResult | null = null;
  for (const c of putExp) {
    const ok = c.puts.filter((r) => r.strike < spot && quoted(r, p))
      .map((r) => ({ r, d: deltaOf(r, spot, c.daysToExpiry, "put") }))
      .filter((x) => -x.d >= p.putAbsDelta[0] && -x.d <= p.putAbsDelta[1]);
    if (!ok.length) continue;
    const atSup = sup ? ok.filter((x) => x.r.strike <= sup.price) : [];
    // highest strike at/below support; no strike there in the Δ band → nearest 0.25Δ (S178 panic RR leg)
    const chosen = atSup.length ? atSup.sort((a, b) => b.r.strike - a.r.strike)[0]
      : ok.sort((a, b) => Math.abs(-a.d - 0.25) - Math.abs(-b.d - 0.25))[0];
    // keep the expiry that sells the most vol (front skew + inverted term); ≥ 1 pt better needed to leave ~30 DTE
    if (!put || chosen.r.iv > put.iv + 0.01) {
      put = { expiry: c.expiry, dte: c.daysToExpiry, strike: chosen.r.strike, bid: chosen.r.bid, ask: chosen.r.ask,
        fill: sellFill(chosen.r, f), iv: chosen.r.iv, delta: chosen.d };
      putChain = c;
    }
  }
  if (!put || !putChain) return null;
  // Rebound target = first resistance ≥ +10 % (a minor swing 1–3 % above spot would force a near-ATM call that costs
  // 2–3× the put credit — live 11-18 run); none → +30 %. Call strike sits between spot and that target.
  const res = lv.resistance.find((x) => x.price >= spot * 1.1) ?? null;
  const cap = res ? res.price : spot * 1.3;
  type Cand = { leg: RRLeg; net: number };
  const best: Cand[] = [];
  for (const c of chains.filter((x) => x.daysToExpiry >= p.callDte[0] && x.daysToExpiry <= p.callDte[1])) {
    const ok = c.calls.filter((r) => r.strike > spot && r.strike <= cap && quoted(r, p))
      .map((r) => ({ r, d: deltaOf(r, spot, c.daysToExpiry, "call") }))
      .filter((x) => x.d >= p.callDelta[0] && x.d <= p.callDelta[1]);
    if (!ok.length) continue;
    const scored = ok.map((x) => ({ x, net: put!.fill - buyFill(x.r, f) }))
      .sort((a, b) => Math.abs(a.net) - Math.abs(b.net));
    const s = scored[0];
    best.push({ leg: { expiry: c.expiry, dte: c.daysToExpiry, strike: s.x.r.strike, bid: s.x.r.bid, ask: s.x.r.ask,
      fill: buyFill(s.x.r, f), iv: s.x.r.iv, delta: s.x.d }, net: s.net });
  }
  if (!best.length) return null;
  const tol = 0.1 * put.fill;
  const even = best.filter((b) => b.net >= -tol).sort((a, b) => b.leg.dte - a.leg.dte);
  const choice = even[0] ?? best.sort((a, b) => b.net - a.net)[0];
  const call = choice.leg;
  const atm = atmIv(putChain, spot);
  const callChain = chains.find((c) => c.expiry === call.expiry)!;
  const atmC = atmIv(callChain, spot);
  const rr = (c: OptionsChainResult) => {
    const p25 = ivAtDelta(c.puts, -0.25), c25 = ivAtDelta(c.calls, 0.25);
    return p25 != null && c25 != null ? p25 - c25 : null;
  };
  const debit = Math.max(0, -choice.net);
  return {
    put, call, spot, net: choice.net, support: sup, resistance: res,
    putSkew: atm ? put.iv / atm : null, callSkew: atmC ? call.iv / atmC : null,
    rr25Put: rr(putChain), rr25Call: rr(callChain), term: atm && atmC ? atmC / atm : null,
    volEdge: put.iv - call.iv, putOverCall: put.iv / call.iv,
    rollsToFund: call.fill / put.fill, rollsAvailable: Math.max(1, Math.floor(call.dte / put.dte)),
    pPutSafe: pAbove(spot, put.strike, put.iv, put.dte),
    pCallItm: pAbove(spot, call.strike, call.iv, call.dte),
    pCallBe: pAbove(spot, call.strike + debit, call.iv, call.dte),
    cashIfAssigned: put.strike * 100, assignedBasis: put.strike - put.fill,
    callMoveToStrike: call.strike / spot - 1,
  };
}
