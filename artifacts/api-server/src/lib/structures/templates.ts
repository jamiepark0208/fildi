/**
 * A192 Part L — named templates from stored chain (deltas / width).
 */
import type { OptionsChainResult } from "../options.js";
import {
  OPTION_MULT,
  pickExpiry,
  priceLegs,
  priceStructure,
  type ChainContext,
  type Leg,
} from "./legs.js";

export type TemplateBuild = { legs: Leg[]; noCredit?: boolean };

const CREDIT_OPT_IDS = new Set<TemplateId>([
  "put_front_ratio",
  "call_front_ratio",
  "put_broken_wing_butterfly",
  "call_broken_wing_butterfly",
  "put_broken_heart",
  "call_broken_heart",
  "jade_lizard",
  "reverse_jade_lizard",
]);

const CREDIT_WIDTHS = [3, 5, 7, 10, 15];
const RATIO_SHORT_DELTA = [0.08, 0.1, 0.12, 0.16, 0.2, 0.25, 0.3, 0.35];
const RATIO_LONG_DELTA = [0.2, 0.25, 0.3, 0.35];
const LIZARD_SHORT_DELTAS = [0.2, 0.25, 0.3, 0.35];
const JADE_PUT_SHORT_DELTAS = [0.25, 0.3, 0.35];
const JADE_CALL_SHORT_DELTAS = [0.2, 0.25, 0.3];
const MAX_SHORT_ABS_DELTA = 0.35;
const LIZARD_SHORT_DELTA_LO = 0.2;
const MAX_NET_STRUCTURE_DELTA = 35;
const CREDIT_SEARCH_CENTER_DELTAS = [0.04, 0.08, 0.12, 0.16, 0.2, 0.25, 0.3, 0.35];

const STRUCTURE_DELTA_CAP_IDS = new Set<TemplateId>([
  "put_front_ratio",
  "call_front_ratio",
  "put_broken_wing_butterfly",
  "call_broken_wing_butterfly",
  "put_broken_heart",
  "call_broken_heart",
]);

function chainRow(chain: OptionsChainResult, side: "call" | "put", strike: number) {
  const rows = side === "call" ? chain.calls : chain.puts;
  return rows.find((r) => r.strike === strike) ?? null;
}

function isOtmStrike(chain: OptionsChainResult, side: "call" | "put", strike: number): boolean {
  return side === "put" ? strike < chain.spot : strike > chain.spot;
}

function absRowDelta(chain: OptionsChainResult, side: "call" | "put", strike: number): number | null {
  const row = chainRow(chain, side, strike);
  if (!row || row.delta == null) return null;
  return Math.abs(row.delta);
}

function shortLegDeltaOk(chain: OptionsChainResult, leg: Leg, lizardShort: boolean): boolean {
  if (leg.strike == null || (leg.kind !== "call" && leg.kind !== "put")) return true;
  const side = leg.kind;
  if (!isOtmStrike(chain, side, leg.strike)) return false;
  const ad = absRowDelta(chain, side, leg.strike);
  if (ad == null) return false;
  if (ad > MAX_SHORT_ABS_DELTA) return false;
  if (lizardShort && ad < LIZARD_SHORT_DELTA_LO) return false;
  return true;
}

/** A192 fix3 — credit search only inside OTM + Δ box (Claude review 7e4a142b). */
function creditOtmShapeOk(
  id: TemplateId,
  legs: Leg[],
  chain: OptionsChainResult,
  ctx: ChainContext,
  horizon: number,
): boolean {
  const lizard = id === "jade_lizard" || id === "reverse_jade_lizard";
  for (const leg of legs) {
    if (leg.strike == null || (leg.kind !== "call" && leg.kind !== "put")) continue;
    if (!isOtmStrike(chain, leg.kind, leg.strike)) return false;
  }
  for (const leg of legs) {
    if (leg.side === "short" && (leg.kind === "call" || leg.kind === "put")) {
      if (!shortLegDeltaOk(chain, leg, lizard)) return false;
    }
  }
  if (STRUCTURE_DELTA_CAP_IDS.has(id)) {
    const priced = priceStructure(legs, ctx, horizon);
    if (Math.abs(priced.greeks.delta) > MAX_NET_STRUCTURE_DELTA) return false;
  }
  return true;
}

function otmStrikeLadder(chain: OptionsChainResult, side: "call" | "put"): number[] {
  return strikeLadder(chain, side).filter((k) => isOtmStrike(chain, side, k));
}

function allOptionLegsOtm(chain: OptionsChainResult, legs: Leg[]): boolean {
  for (const leg of legs) {
    if (leg.strike == null || (leg.kind !== "call" && leg.kind !== "put")) continue;
    if (!isOtmStrike(chain, leg.kind, leg.strike)) return false;
  }
  return true;
}

function pushCreditCandidate(out: Leg[][], chain: OptionsChainResult, legs: Leg[]) {
  if (!allOptionLegsOtm(chain, legs)) return;
  out.push(legs);
}

function lizardWingDollars(id: "jade_lizard" | "reverse_jade_lizard", legs: Leg[]): number {
  if (id === "jade_lizard") {
    const sCall = legs.find((l) => l.kind === "call" && l.side === "short");
    const lCall = legs.find((l) => l.kind === "call" && l.side === "long");
    if (!sCall?.strike || !lCall?.strike) return 0;
    return Math.max(0, lCall.strike - sCall.strike) * OPTION_MULT;
  }
  const sPut = legs.find((l) => l.kind === "put" && l.side === "short");
  const lPut = legs.find((l) => l.kind === "put" && l.side === "long");
  if (!sPut?.strike || !lPut?.strike) return 0;
  return Math.max(0, sPut.strike - lPut.strike) * OPTION_MULT;
}

function creditSatisfied(id: TemplateId, legs: Leg[], netFill: number): boolean {
  if (netFill <= 0) return false;
  if (id === "jade_lizard" || id === "reverse_jade_lizard") {
    return netFill >= lizardWingDollars(id, legs);
  }
  return true;
}

function lizardShapeOk(id: "jade_lizard" | "reverse_jade_lizard", legs: Leg[], ctx: ChainContext, horizon: number): boolean {
  const priced = priceStructure(legs, ctx, horizon);
  if (id === "jade_lizard") {
    return (
      priced.breakevens.length === 1
      && priced.breakevens[0]! < ctx.spot
      && priced.greeks.delta > 5
    );
  }
  return (
    priced.breakevens.length === 1
    && priced.breakevens[0]! > ctx.spot
    && priced.greeks.delta < -5
  );
}

function pickBestCreditCandidate(
  id: TemplateId,
  chain: OptionsChainResult,
  candidates: Leg[][],
  ctx: ChainContext,
  horizon: number,
): TemplateBuild {
  let bestOk: Leg[] | null = null;
  let bestOkFill = -Infinity;
  let bestAny: Leg[] | null = null;
  let bestAnyFill = -Infinity;
  for (const legs of candidates) {
    if (!creditOtmShapeOk(id, legs, chain, ctx, horizon)) continue;
    const { netFill, unquoted } = priceLegs(legs, ctx);
    // A205 unit 2: an unquoted leg adds 0 (a free wing inflates credit) → only quoted candidates compete.
    if (unquoted > 0) {
      if (!bestAny) bestAny = legs;
      continue;
    }
    if (netFill > bestAnyFill) {
      bestAnyFill = netFill;
      bestAny = legs;
    }
    if (!creditSatisfied(id, legs, netFill)) continue;
    if (id === "jade_lizard" || id === "reverse_jade_lizard") {
      if (!lizardShapeOk(id, legs, ctx, horizon)) continue;
    }
    if (netFill > bestOkFill) {
      bestOkFill = netFill;
      bestOk = legs;
    }
  }
  if (!bestAny) return { legs: [], noCredit: true };
  const legs = bestOk ?? bestAny;
  const { netFill } = priceLegs(legs, ctx);
  const noCredit =
    !creditSatisfied(id, legs, netFill)
    || ((id === "jade_lizard" || id === "reverse_jade_lizard") && !lizardShapeOk(id, legs, ctx, horizon));
  return noCredit ? { legs, noCredit: true } : { legs };
}

function strikeLadder(chain: OptionsChainResult, side: "call" | "put"): number[] {
  const rows = side === "call" ? chain.calls : chain.puts;
  return [...new Set(rows.map((r) => r.strike))].sort((a, b) => a - b);
}

function creditCandidates(id: TemplateId, chain: OptionsChainResult, width: number): Leg[][] {
  const out: Leg[][] = [];
  const centerDeltas = CREDIT_SEARCH_CENTER_DELTAS;
  const widths = [...new Set([width, ...CREDIT_WIDTHS])];
  const exp = chain.expiry;

  if (id === "put_front_ratio") {
    const puts = otmStrikeLadder(chain, "put");
    for (let li = 0; li < puts.length; li++) {
      for (let si = 0; si < li; si++) {
        const shortK = puts[si]!;
        const longK = puts[li]!;
        if (absRowDelta(chain, "put", shortK)! > MAX_SHORT_ABS_DELTA) continue;
        out.push([
          { kind: "put", side: "long", qty: 1, strike: longK, expiry: exp },
          { kind: "put", side: "short", qty: 2, strike: shortK, expiry: exp },
        ]);
      }
    }
    for (const shortD of RATIO_SHORT_DELTA) {
      for (const longD of RATIO_LONG_DELTA) {
        const short = nearestByDelta(chain, "put", shortD);
        const lng = nearestByDelta(chain, "put", longD);
        if (!short || !lng || lng.strike <= short.strike) continue;
        if (!isOtmStrike(chain, "put", short.strike) || !isOtmStrike(chain, "put", lng.strike)) continue;
        const sAd = absRowDelta(chain, "put", short.strike);
        if (sAd == null || sAd > MAX_SHORT_ABS_DELTA) continue;
        out.push([
          { kind: "put", side: "long", qty: 1, strike: lng.strike, expiry: lng.expiry },
          { kind: "put", side: "short", qty: 2, strike: short.strike, expiry: short.expiry },
        ]);
      }
    }
    return out;
  }
  if (id === "call_front_ratio") {
    const calls = otmStrikeLadder(chain, "call");
    for (let lo = 0; lo < calls.length; lo++) {
      for (let hi = lo + 1; hi < calls.length; hi++) {
        const longK = calls[lo]!;
        const shortK = calls[hi]!;
        if (absRowDelta(chain, "call", shortK)! > MAX_SHORT_ABS_DELTA) continue;
        out.push([
          { kind: "call", side: "long", qty: 1, strike: longK, expiry: exp },
          { kind: "call", side: "short", qty: 2, strike: shortK, expiry: exp },
        ]);
      }
    }
    for (const shortD of RATIO_SHORT_DELTA) {
      for (const longD of RATIO_LONG_DELTA) {
        const short = nearestByDelta(chain, "call", shortD);
        const lng = nearestByDelta(chain, "call", longD);
        if (!short || !lng || lng.strike >= short.strike) continue;
        if (!isOtmStrike(chain, "call", short.strike) || !isOtmStrike(chain, "call", lng.strike)) continue;
        const sAd = absRowDelta(chain, "call", short.strike);
        if (sAd == null || sAd > MAX_SHORT_ABS_DELTA) continue;
        out.push([
          { kind: "call", side: "long", qty: 1, strike: lng.strike, expiry: lng.expiry },
          { kind: "call", side: "short", qty: 2, strike: short.strike, expiry: short.expiry },
        ]);
      }
    }
    return out;
  }
  if (id === "put_broken_wing_butterfly") {
    for (const d of centerDeltas) {
      const center = nearestByDelta(chain, "put", d);
      if (!center || !isOtmStrike(chain, "put", center.strike)) continue;
      const cAd = absRowDelta(chain, "put", center.strike);
      if (cAd == null || cAd > MAX_SHORT_ABS_DELTA) continue;
      for (const w of widths) {
        if (center.strike + w >= chain.spot) continue;
        const hi = pickWidth(chain, "put", center.strike, -w);
        const lo = pickWidth(chain, "put", center.strike, w * 2);
        if (hi >= chain.spot) continue;
        pushCreditCandidate(out, chain, [
          { kind: "put", side: "long", qty: 1, strike: hi, expiry: center.expiry },
          { kind: "put", side: "short", qty: 2, strike: center.strike, expiry: center.expiry },
          { kind: "put", side: "long", qty: 1, strike: lo, expiry: center.expiry },
        ]);
      }
    }
    return out;
  }
  if (id === "call_broken_wing_butterfly") {
    for (const d of centerDeltas) {
      const center = nearestByDelta(chain, "call", d);
      if (!center || !isOtmStrike(chain, "call", center.strike)) continue;
      const cAd = absRowDelta(chain, "call", center.strike);
      if (cAd == null || cAd > MAX_SHORT_ABS_DELTA) continue;
      for (const w of widths) {
        if (center.strike - w <= chain.spot) continue;
        const lo = pickWidth(chain, "call", center.strike, -w);
        const hi = pickWidth(chain, "call", center.strike, w * 2);
        pushCreditCandidate(out, chain, [
          { kind: "call", side: "long", qty: 1, strike: lo, expiry: center.expiry },
          { kind: "call", side: "short", qty: 2, strike: center.strike, expiry: center.expiry },
          { kind: "call", side: "long", qty: 1, strike: hi, expiry: center.expiry },
        ]);
      }
    }
    return out;
  }
  if (id === "put_broken_heart") {
    const puts = otmStrikeLadder(chain, "put");
    const n = puts.length;
    for (let a = 0; a < n - 3; a++) {
      for (let b = a + 1; b < n - 2; b++) {
        for (let c = b + 1; c < n - 1; c++) {
          for (let d = c + 1; d < n; d++) {
            const [kFarLo, kMidLo, center, kHi] = [puts[a], puts[b], puts[c], puts[d]];
            out.push([
              { kind: "put", side: "long", qty: 1, strike: kHi, expiry: exp },
              { kind: "put", side: "short", qty: 1, strike: center, expiry: exp },
              { kind: "put", side: "short", qty: 1, strike: kMidLo, expiry: exp },
              { kind: "put", side: "long", qty: 1, strike: kFarLo, expiry: exp },
            ]);
          }
        }
      }
    }
    for (const d of centerDeltas) {
      const center = nearestByDelta(chain, "put", d);
      if (!center) continue;
      for (const w of widths) {
        const kHi = pickWidth(chain, "put", center.strike, -w);
        const kMidLo = pickWidth(chain, "put", center.strike, w);
        const kFarLo = pickWidth(chain, "put", center.strike, w * 2);
        out.push([
          { kind: "put", side: "long", qty: 1, strike: kHi, expiry: center.expiry },
          { kind: "put", side: "short", qty: 1, strike: center.strike, expiry: center.expiry },
          { kind: "put", side: "short", qty: 1, strike: kMidLo, expiry: center.expiry },
          { kind: "put", side: "long", qty: 1, strike: kFarLo, expiry: center.expiry },
        ]);
      }
    }
    return out;
  }
  if (id === "call_broken_heart") {
    const calls = otmStrikeLadder(chain, "call");
    const n = calls.length;
    for (let a = 0; a < n - 3; a++) {
      for (let b = a + 1; b < n - 2; b++) {
        for (let c = b + 1; c < n - 1; c++) {
          for (let d = c + 1; d < n; d++) {
            const [kLo, center, kMidHi, kFarHi] = [calls[a], calls[b], calls[c], calls[d]];
            out.push([
              { kind: "call", side: "long", qty: 1, strike: kLo, expiry: exp },
              { kind: "call", side: "short", qty: 1, strike: center, expiry: exp },
              { kind: "call", side: "short", qty: 1, strike: kMidHi, expiry: exp },
              { kind: "call", side: "long", qty: 1, strike: kFarHi, expiry: exp },
            ]);
          }
        }
      }
    }
    for (const d of centerDeltas) {
      const center = nearestByDelta(chain, "call", d);
      if (!center) continue;
      for (const w of widths) {
        const kLo = pickWidth(chain, "call", center.strike, -w);
        const kMidHi = pickWidth(chain, "call", center.strike, w);
        const kFarHi = pickWidth(chain, "call", center.strike, w * 2);
        out.push([
          { kind: "call", side: "long", qty: 1, strike: kLo, expiry: center.expiry },
          { kind: "call", side: "short", qty: 1, strike: center.strike, expiry: center.expiry },
          { kind: "call", side: "short", qty: 1, strike: kMidHi, expiry: center.expiry },
          { kind: "call", side: "long", qty: 1, strike: kFarHi, expiry: center.expiry },
        ]);
      }
    }
    return out;
  }
  if (id === "jade_lizard") {
    for (const pd of JADE_PUT_SHORT_DELTAS) {
      const sPut = nearestByDelta(chain, "put", pd);
      if (!sPut || !isOtmStrike(chain, "put", sPut.strike)) continue;
      const putAd = absRowDelta(chain, "put", sPut.strike);
      if (putAd == null || putAd < LIZARD_SHORT_DELTA_LO || putAd > MAX_SHORT_ABS_DELTA) continue;
      for (const cd of JADE_CALL_SHORT_DELTAS) {
        const sCall = nearestByDelta(chain, "call", cd);
        if (!sCall || !isOtmStrike(chain, "call", sCall.strike)) continue;
        const callAd = absRowDelta(chain, "call", sCall.strike);
        if (callAd == null || callAd < LIZARD_SHORT_DELTA_LO || callAd > MAX_SHORT_ABS_DELTA) continue;
        for (const w of widths) {
          const longCall = pickWidth(chain, "call", sCall.strike, w);
          if (!isOtmStrike(chain, "call", longCall) || longCall <= sCall.strike) continue;
          pushCreditCandidate(out, chain, [
            { kind: "put", side: "short", qty: 1, strike: sPut.strike, expiry: sPut.expiry },
            { kind: "call", side: "short", qty: 1, strike: sCall.strike, expiry: sCall.expiry },
            { kind: "call", side: "long", qty: 1, strike: longCall, expiry: sCall.expiry },
          ]);
        }
      }
    }
    return out;
  }
  if (id === "reverse_jade_lizard") {
    for (const cd of JADE_CALL_SHORT_DELTAS) {
      const sCall = nearestByDelta(chain, "call", cd);
      if (!sCall || !isOtmStrike(chain, "call", sCall.strike)) continue;
      const callAd = absRowDelta(chain, "call", sCall.strike);
      if (callAd == null || callAd < LIZARD_SHORT_DELTA_LO || callAd > MAX_SHORT_ABS_DELTA) continue;
      for (const pd of JADE_PUT_SHORT_DELTAS) {
        const sPut = nearestByDelta(chain, "put", pd);
        if (!sPut || !isOtmStrike(chain, "put", sPut.strike)) continue;
        const putAd = absRowDelta(chain, "put", sPut.strike);
        if (putAd == null || putAd < LIZARD_SHORT_DELTA_LO || putAd > MAX_SHORT_ABS_DELTA) continue;
        for (const w of widths) {
          const longPut = pickWidth(chain, "put", sPut.strike, -w);
          if (!isOtmStrike(chain, "put", longPut) || longPut >= sPut.strike) continue;
          pushCreditCandidate(out, chain, [
            { kind: "call", side: "short", qty: 1, strike: sCall.strike, expiry: sCall.expiry },
            { kind: "put", side: "short", qty: 1, strike: sPut.strike, expiry: sPut.expiry },
            { kind: "put", side: "long", qty: 1, strike: longPut, expiry: sPut.expiry },
          ]);
        }
      }
    }
    return out;
  }
  return out;
}

function buildCreditOptimizedTemplate(
  id: TemplateId,
  opts: BuildOpts,
  chain: OptionsChainResult,
  width: number,
): TemplateBuild {
  const ctx: ChainContext = { spot: chain.spot, chains: opts.chains };
  const horizon = opts.horizonDays ?? 37;
  const candidates = creditCandidates(id, chain, width);
  const fallback = buildTemplateLegs(id, opts);
  if (fallback) candidates.push(fallback);
  if (!candidates.length) return { legs: fallback ?? [], noCredit: true };
  const picked = pickBestCreditCandidate(id, chain, candidates, ctx, horizon);
  if (!picked.legs.length && fallback?.length) return { legs: fallback, noCredit: true };
  return picked;
}

export type TemplateId =
  | "long_stock"
  | "short_stock"
  | "cash_secured_put"
  | "covered_call"
  | "collar"
  | "long_call"
  | "long_put"
  | "bull_put_spread"
  | "bear_call_spread"
  | "debit_call_vertical"
  | "debit_put_vertical"
  | "iron_condor"
  | "long_strangle"
  | "short_strangle"
  | "long_straddle"
  | "short_straddle"
  | "calendar"
  | "diagonal"
  | "pmcc"
  | "jade_lizard"
  | "iron_fly"
  | "call_zebra"
  | "put_zebra"
  | "put_calendar"
  | "call_butterfly"
  | "put_butterfly"
  | "big_lizard"
  | "reverse_big_lizard"
  | "covered_put"
  | "put_diagonal"
  | "put_front_ratio"
  | "call_front_ratio"
  | "put_broken_wing_butterfly"
  | "call_broken_wing_butterfly"
  | "put_broken_heart"
  | "call_broken_heart"
  | "dynamic_iron_condor"
  | "short_naked_call"
  | "reverse_jade_lizard";

export const TEMPLATE_LABELS: Record<TemplateId, string> = {
  long_stock: "Long stock",
  short_stock: "Short stock",
  cash_secured_put: "Cash-secured put",
  covered_call: "Covered call",
  collar: "Collar",
  long_call: "Long call",
  long_put: "Long put",
  bull_put_spread: "Bull put spread",
  bear_call_spread: "Bear call spread",
  debit_call_vertical: "Debit call vertical",
  debit_put_vertical: "Debit put vertical",
  iron_condor: "Iron condor",
  long_strangle: "Long strangle",
  short_strangle: "Short strangle",
  long_straddle: "Long straddle",
  short_straddle: "Short straddle",
  calendar: "Call calendar",
  diagonal: "Call diagonal",
  pmcc: "Poor man's covered call",
  jade_lizard: "Jade lizard",
  iron_fly: "Iron butterfly",
  call_zebra: "Call ZEBRA",
  put_zebra: "Put ZEBRA",
  put_calendar: "Put calendar",
  call_butterfly: "Call butterfly",
  put_butterfly: "Put butterfly",
  big_lizard: "Big lizard",
  reverse_big_lizard: "Reverse big lizard",
  covered_put: "Covered put",
  put_diagonal: "Poor man's covered put",
  put_front_ratio: "Put front-ratio",
  call_front_ratio: "Call front-ratio",
  put_broken_wing_butterfly: "Put broken-wing butterfly",
  call_broken_wing_butterfly: "Call broken-wing butterfly",
  put_broken_heart: "Put broken-heart butterfly",
  call_broken_heart: "Call broken-heart butterfly",
  dynamic_iron_condor: "Dynamic-width iron condor",
  short_naked_call: "Short naked call",
  reverse_jade_lizard: "Reverse jade lizard",
};

function nearestByDelta(
  chain: OptionsChainResult,
  side: "call" | "put",
  targetAbsDelta: number,
): { strike: number; expiry: string } | null {
  const rows = side === "call" ? chain.calls : chain.puts;
  if (!rows.length) return null;
  let best = rows[0];
  let bestDiff = Infinity;
  let anyDelta = false;
  for (const r of rows) {
    if (r.delta == null) continue;
    anyDelta = true;
    const d = Math.abs(Math.abs(r.delta) - targetAbsDelta);
    if (d < bestDiff) {
      best = r;
      bestDiff = d;
    }
  }
  if (!anyDelta) {
    const spot = chain.spot;
    const otm = side === "put"
      ? spot * (1 - targetAbsDelta * 0.15)
      : spot * (1 + targetAbsDelta * 0.15);
    let near = rows[0];
    let nd = Infinity;
    for (const r of rows) {
      const d = Math.abs(r.strike - otm);
      if (d < nd) {
        near = r;
        nd = d;
      }
    }
    best = near;
  }
  return { strike: best.strike, expiry: chain.expiry };
}

function pickWidth(chain: OptionsChainResult, side: "call" | "put", shortStrike: number, width: number): number {
  const rows = side === "call" ? chain.calls : chain.puts;
  const targets = rows.map((r) => r.strike).sort((a, b) => a - b);
  const want = side === "put" ? shortStrike - width : shortStrike + width;
  let best = targets[0];
  let diff = Infinity;
  for (const k of targets) {
    const d = Math.abs(k - want);
    if (d < diff) {
      best = k;
      diff = d;
    }
  }
  return best;
}

export interface BuildOpts {
  chains: OptionsChainResult[];
  horizonDays?: number;
  width?: number;
}

function chainForHorizon(
  chains: OptionsChainResult[],
  horizon: number,
  side: "put" | "call" | "both",
): OptionsChainResult | null {
  const sorted = [...chains].sort(
    (a, b) => Math.abs(a.daysToExpiry - horizon) - Math.abs(b.daysToExpiry - horizon),
  );
  for (const c of sorted) {
    if (side === "put" && !c.puts.length) continue;
    if (side === "call" && !c.calls.length) continue;
    if (side === "both" && (!c.puts.length || !c.calls.length)) continue;
    return c;
  }
  return pickExpiry(chains, horizon);
}

const TEMPLATE_CHAIN_SIDE: Partial<Record<TemplateId, "put" | "call" | "both">> = {
  cash_secured_put: "put",
  long_put: "put",
  bull_put_spread: "put",
  debit_put_vertical: "put",
  long_call: "call",
  covered_call: "both",
  bear_call_spread: "call",
  debit_call_vertical: "call",
  pmcc: "call",
  jade_lizard: "both",
  iron_fly: "both",
  call_zebra: "call",
  put_zebra: "put",
  put_calendar: "put",
  call_butterfly: "call",
  put_butterfly: "put",
  big_lizard: "both",
  reverse_big_lizard: "both",
  covered_put: "put",
  put_diagonal: "put",
  put_front_ratio: "put",
  call_front_ratio: "call",
  put_broken_wing_butterfly: "put",
  call_broken_wing_butterfly: "call",
  put_broken_heart: "put",
  call_broken_heart: "call",
  dynamic_iron_condor: "both",
  short_naked_call: "call",
  reverse_jade_lizard: "both",
};

/** A205: strike nearest spot that is quoted (bid or ask > 0) in every (chain, side) a structure needs — was the put-side ATM,
 *  which the call side often did not list → leg priced as free / unpriced. */
function commonAtmStrike(spot: number, need: Array<[OptionsChainResult, "put" | "call"]>): number | null {
  const sets = need.map(([c, k]) => new Set((k === "put" ? c.puts : c.calls).filter((r) => (r.ask ?? 0) > 0 || (r.bid ?? 0) > 0).map((r) => r.strike)));
  const common = [...sets[0]].filter((k) => sets.every((s) => s.has(k)));
  if (!common.length) return null;
  return common.reduce((a, b) => (Math.abs(b - spot) < Math.abs(a - spot) ? b : a));
}

/** Calendar/diagonal expiries: front = the horizon expiry, back = the later expiry nearest front + 30 d (≥ front + 14 d when listed). */
function calendarPair(chains: OptionsChainResult[], horizon: number): { front: OptionsChainResult; back: OptionsChainResult } | null {
  const sorted = [...chains].filter((c) => c.puts.length || c.calls.length).sort((a, b) => a.daysToExpiry - b.daysToExpiry);
  if (sorted.length < 2) return null;
  const front = pickExpiry(sorted.slice(0, -1), horizon) ?? sorted[0];
  const later = sorted.filter((c) => c.daysToExpiry > front.daysToExpiry);
  if (!later.length) return null;
  const pool = later.filter((c) => c.daysToExpiry >= front.daysToExpiry + 14);
  const back = (pool.length ? pool : later).reduce((a, b) =>
    Math.abs(b.daysToExpiry - front.daysToExpiry - 30) < Math.abs(a.daysToExpiry - front.daysToExpiry - 30) ? b : a);
  return { front, back };
}

export function buildTemplate(id: TemplateId, opts: BuildOpts): TemplateBuild | null {
  const legsOnly = buildTemplateLegs(id, opts);
  if (!legsOnly) return null;
  if (!CREDIT_OPT_IDS.has(id)) return { legs: legsOnly };
  const horizon = opts.horizonDays ?? 37;
  const chainSide = TEMPLATE_CHAIN_SIDE[id] ?? "both";
  const chain =
    id === "long_stock" || id === "short_stock"
      ? opts.chains[0]
      : chainForHorizon(opts.chains, horizon, chainSide);
  if (!chain) return { legs: legsOnly, noCredit: true };
  return buildCreditOptimizedTemplate(id, opts, chain, opts.width ?? 5);
}

function buildTemplateLegs(id: TemplateId, opts: BuildOpts): Leg[] | null {
  const horizon = opts.horizonDays ?? 37;
  const chainSide = TEMPLATE_CHAIN_SIDE[id] ?? "both";
  const chain = id === "long_stock" || id === "short_stock"
    ? opts.chains[0]
    : chainForHorizon(opts.chains, horizon, chainSide);
  if (!chain && id !== "long_stock" && id !== "short_stock") return null;
  const width = opts.width ?? 5;

  switch (id) {
    case "long_stock":
      return [{ kind: "stock", side: "long", qty: 100 }];
    case "short_stock":
      return [{ kind: "stock", side: "short", qty: 100 }];
    case "cash_secured_put": {
      const leg = nearestByDelta(chain!, "put", 0.3);
      if (!leg) return null;
      return [{ kind: "put", side: "short", qty: 1, strike: leg.strike, expiry: leg.expiry }];
    }
    case "covered_call": {
      const leg = nearestByDelta(chain!, "call", 0.3);
      if (!leg) return null;
      return [
        { kind: "stock", side: "long", qty: 100 },
        { kind: "call", side: "short", qty: 1, strike: leg.strike, expiry: leg.expiry },
      ];
    }
    case "long_call": {
      const leg = nearestByDelta(chain!, "call", 0.4);
      if (!leg) return null;
      return [{ kind: "call", side: "long", qty: 1, strike: leg.strike, expiry: leg.expiry }];
    }
    case "long_put": {
      const leg = nearestByDelta(chain!, "put", 0.4);
      if (!leg) return null;
      return [{ kind: "put", side: "long", qty: 1, strike: leg.strike, expiry: leg.expiry }];
    }
    case "bull_put_spread": {
      const short = nearestByDelta(chain!, "put", 0.3);
      if (!short) return null;
      const longK = pickWidth(chain!, "put", short.strike, width);
      return [
        { kind: "put", side: "short", qty: 1, strike: short.strike, expiry: short.expiry },
        { kind: "put", side: "long", qty: 1, strike: longK, expiry: short.expiry },
      ];
    }
    case "bear_call_spread": {
      const short = nearestByDelta(chain!, "call", 0.3);
      if (!short) return null;
      const longK = pickWidth(chain!, "call", short.strike, width);
      return [
        { kind: "call", side: "short", qty: 1, strike: short.strike, expiry: short.expiry },
        { kind: "call", side: "long", qty: 1, strike: longK, expiry: short.expiry },
      ];
    }
    case "debit_call_vertical": {
      const long = nearestByDelta(chain!, "call", 0.45);
      const short = nearestByDelta(chain!, "call", 0.25);
      if (!long || !short) return null;
      return [
        { kind: "call", side: "long", qty: 1, strike: long.strike, expiry: long.expiry },
        { kind: "call", side: "short", qty: 1, strike: short.strike, expiry: short.expiry },
      ];
    }
    case "debit_put_vertical": {
      const long = nearestByDelta(chain!, "put", 0.45);
      const short = nearestByDelta(chain!, "put", 0.25);
      if (!long || !short) return null;
      return [
        { kind: "put", side: "long", qty: 1, strike: long.strike, expiry: long.expiry },
        { kind: "put", side: "short", qty: 1, strike: short.strike, expiry: short.expiry },
      ];
    }
    case "iron_condor": {
      const putShort = nearestByDelta(chain!, "put", 0.2);
      const callShort = nearestByDelta(chain!, "call", 0.2);
      if (!putShort || !callShort) return null;
      const putLong = pickWidth(chain!, "put", putShort.strike, width);
      const callLong = pickWidth(chain!, "call", callShort.strike, width);
      return [
        { kind: "put", side: "short", qty: 1, strike: putShort.strike, expiry: putShort.expiry },
        { kind: "put", side: "long", qty: 1, strike: putLong, expiry: putShort.expiry },
        { kind: "call", side: "short", qty: 1, strike: callShort.strike, expiry: callShort.expiry },
        { kind: "call", side: "long", qty: 1, strike: callLong, expiry: callShort.expiry },
      ];
    }
    case "long_straddle": {
      const k = commonAtmStrike(chain!.spot, [[chain!, "call"], [chain!, "put"]]);
      if (k == null) return null;
      return [
        { kind: "call", side: "long", qty: 1, strike: k, expiry: chain!.expiry },
        { kind: "put", side: "long", qty: 1, strike: k, expiry: chain!.expiry },
      ];
    }
    case "short_straddle": {
      const k = commonAtmStrike(chain!.spot, [[chain!, "call"], [chain!, "put"]]);
      if (k == null) return null;
      return [
        { kind: "call", side: "short", qty: 1, strike: k, expiry: chain!.expiry },
        { kind: "put", side: "short", qty: 1, strike: k, expiry: chain!.expiry },
      ];
    }
    case "long_strangle": {
      const put = nearestByDelta(chain!, "put", 0.25);
      const call = nearestByDelta(chain!, "call", 0.25);
      if (!put || !call) return null;
      return [
        { kind: "put", side: "long", qty: 1, strike: put.strike, expiry: put.expiry },
        { kind: "call", side: "long", qty: 1, strike: call.strike, expiry: call.expiry },
      ];
    }
    case "short_strangle": {
      const put = nearestByDelta(chain!, "put", 0.25);
      const call = nearestByDelta(chain!, "call", 0.25);
      if (!put || !call) return null;
      return [
        { kind: "put", side: "short", qty: 1, strike: put.strike, expiry: put.expiry },
        { kind: "call", side: "short", qty: 1, strike: call.strike, expiry: call.expiry },
      ];
    }
    case "collar": {
      const put = nearestByDelta(chain!, "put", 0.25);
      const call = nearestByDelta(chain!, "call", 0.25);
      if (!put || !call) return null;
      return [
        { kind: "stock", side: "long", qty: 100 },
        { kind: "put", side: "long", qty: 1, strike: put.strike, expiry: put.expiry },
        { kind: "call", side: "short", qty: 1, strike: call.strike, expiry: call.expiry },
      ];
    }
    case "calendar": {
      const pair = calendarPair(opts.chains, opts.horizonDays ?? 30);
      if (!pair) return null;
      const k = commonAtmStrike(pair.front.spot, [[pair.front, "call"], [pair.back, "call"]]);
      if (k == null) return null;
      return [
        { kind: "call", side: "short", qty: 1, strike: k, expiry: pair.front.expiry },
        { kind: "call", side: "long", qty: 1, strike: k, expiry: pair.back.expiry },
      ];
    }
    case "diagonal": {
      const pair = calendarPair(opts.chains, opts.horizonDays ?? 30);
      if (!pair) return null;
      const { front, back } = pair;
      const short = nearestByDelta(front, "call", 0.35);
      const long = nearestByDelta(back, "call", 0.45);
      if (!short || !long) return null;
      return [
        { kind: "call", side: "short", qty: 1, strike: short.strike, expiry: short.expiry },
        { kind: "call", side: "long", qty: 1, strike: long.strike, expiry: long.expiry },
      ];
    }
    case "pmcc": {
      const back = pickExpiry(opts.chains, 180);
      const short = nearestByDelta(chain!, "call", 0.3);
      const long = back ? nearestByDelta(back, "call", 0.7) : null;
      if (!short || !long) return null;
      return [
        { kind: "call", side: "long", qty: 1, strike: long.strike, expiry: long.expiry },
        { kind: "call", side: "short", qty: 1, strike: short.strike, expiry: short.expiry },
      ];
    }
    case "jade_lizard": {
      const sPut = nearestByDelta(chain!, "put", 0.25);
      const sCall = nearestByDelta(chain!, "call", 0.25);
      if (!sPut || !sCall) return null;
      const longCall = pickWidth(chain!, "call", sCall.strike, width);
      return [
        { kind: "put", side: "short", qty: 1, strike: sPut.strike, expiry: sPut.expiry },
        { kind: "call", side: "short", qty: 1, strike: sCall.strike, expiry: sCall.expiry },
        { kind: "call", side: "long", qty: 1, strike: longCall, expiry: sCall.expiry },
      ];
    }
    case "reverse_jade_lizard": {
      const sCall = nearestByDelta(chain!, "call", 0.25);
      const sPut = nearestByDelta(chain!, "put", 0.25);
      if (!sCall || !sPut) return null;
      const longPut = pickWidth(chain!, "put", sPut.strike, width);
      return [
        { kind: "call", side: "short", qty: 1, strike: sCall.strike, expiry: sCall.expiry },
        { kind: "put", side: "short", qty: 1, strike: sPut.strike, expiry: sPut.expiry },
        { kind: "put", side: "long", qty: 1, strike: longPut, expiry: sPut.expiry },
      ];
    }
    case "iron_fly": {
      const atmK = commonAtmStrike(chain!.spot, [[chain!, "put"], [chain!, "call"]]);
      if (atmK == null) return null;
      const atm = { strike: atmK };
      const putWing = pickWidth(chain!, "put", atm.strike, width * 2);
      const callWing = pickWidth(chain!, "call", atm.strike, width * 2);
      return [
        { kind: "put", side: "short", qty: 1, strike: atm.strike, expiry: chain!.expiry },
        { kind: "call", side: "short", qty: 1, strike: atm.strike, expiry: chain!.expiry },
        { kind: "put", side: "long", qty: 1, strike: putWing, expiry: chain!.expiry },
        { kind: "call", side: "long", qty: 1, strike: callWing, expiry: chain!.expiry },
      ];
    }
    case "dynamic_iron_condor": {
      const putShort = nearestByDelta(chain!, "put", 0.2);
      const callShort = nearestByDelta(chain!, "call", 0.2);
      if (!putShort || !callShort) return null;
      const putLong = pickWidth(chain!, "put", putShort.strike, width);
      const callLong = pickWidth(chain!, "call", callShort.strike, width * 2);
      return [
        { kind: "put", side: "short", qty: 1, strike: putShort.strike, expiry: putShort.expiry },
        { kind: "put", side: "long", qty: 1, strike: putLong, expiry: putShort.expiry },
        { kind: "call", side: "short", qty: 1, strike: callShort.strike, expiry: callShort.expiry },
        { kind: "call", side: "long", qty: 1, strike: callLong, expiry: callShort.expiry },
      ];
    }
    case "call_zebra": {
      const deep = nearestByDelta(chain!, "call", 0.7);
      const atm = nearestByDelta(chain!, "call", 0.5);
      if (!deep || !atm) return null;
      return [
        { kind: "call", side: "long", qty: 2, strike: deep.strike, expiry: deep.expiry },
        { kind: "call", side: "short", qty: 1, strike: atm.strike, expiry: atm.expiry },
      ];
    }
    case "put_zebra": {
      const deep = nearestByDelta(chain!, "put", 0.7);
      const atm = nearestByDelta(chain!, "put", 0.5);
      if (!deep || !atm) return null;
      return [
        { kind: "put", side: "long", qty: 2, strike: deep.strike, expiry: deep.expiry },
        { kind: "put", side: "short", qty: 1, strike: atm.strike, expiry: atm.expiry },
      ];
    }
    case "put_calendar": {
      const pair = calendarPair(opts.chains, opts.horizonDays ?? 30);
      if (!pair) return null;
      const k = commonAtmStrike(pair.front.spot, [[pair.front, "put"], [pair.back, "put"]]);
      if (k == null) return null;
      return [
        { kind: "put", side: "short", qty: 1, strike: k, expiry: pair.front.expiry },
        { kind: "put", side: "long", qty: 1, strike: k, expiry: pair.back.expiry },
      ];
    }
    case "call_butterfly": {
      const body = nearestByDelta(chain!, "call", 0.5);
      if (!body) return null;
      const lo = pickWidth(chain!, "call", body.strike, -width);
      const hi = pickWidth(chain!, "call", body.strike, width);
      return [
        { kind: "call", side: "long", qty: 1, strike: lo, expiry: body.expiry },
        { kind: "call", side: "short", qty: 2, strike: body.strike, expiry: body.expiry },
        { kind: "call", side: "long", qty: 1, strike: hi, expiry: body.expiry },
      ];
    }
    case "put_butterfly": {
      const body = nearestByDelta(chain!, "put", 0.5);
      if (!body) return null;
      const lo = pickWidth(chain!, "put", body.strike, width);
      const hi = pickWidth(chain!, "put", body.strike, -width);
      return [
        { kind: "put", side: "long", qty: 1, strike: lo, expiry: body.expiry },
        { kind: "put", side: "short", qty: 2, strike: body.strike, expiry: body.expiry },
        { kind: "put", side: "long", qty: 1, strike: hi, expiry: body.expiry },
      ];
    }
    case "big_lizard": {
      const atmK = commonAtmStrike(chain!.spot, [[chain!, "put"], [chain!, "call"]]);
      if (atmK == null) return null;
      const atm = { strike: atmK };
      const longCall = pickWidth(chain!, "call", atm.strike, width);
      return [
        { kind: "put", side: "short", qty: 1, strike: atm.strike, expiry: chain!.expiry },
        { kind: "call", side: "short", qty: 1, strike: atm.strike, expiry: chain!.expiry },
        { kind: "call", side: "long", qty: 1, strike: longCall, expiry: chain!.expiry },
      ];
    }
    case "reverse_big_lizard": {
      const atmK = commonAtmStrike(chain!.spot, [[chain!, "put"], [chain!, "call"]]);
      if (atmK == null) return null;
      const atm = { strike: atmK };
      const longPut = pickWidth(chain!, "put", atm.strike, width);
      return [
        { kind: "call", side: "short", qty: 1, strike: atm.strike, expiry: chain!.expiry },
        { kind: "put", side: "short", qty: 1, strike: atm.strike, expiry: chain!.expiry },
        { kind: "put", side: "long", qty: 1, strike: longPut, expiry: chain!.expiry },
      ];
    }
    case "covered_put": {
      const sPut = nearestByDelta(chain!, "put", 0.3);
      if (!sPut) return null;
      return [
        { kind: "stock", side: "short", qty: 100 },
        { kind: "put", side: "short", qty: 1, strike: sPut.strike, expiry: sPut.expiry },
      ];
    }
    case "put_diagonal": {
      const sorted = [...opts.chains].sort((a, b) => a.daysToExpiry - b.daysToExpiry);
      if (sorted.length < 2) return null;
      const front = sorted[0];
      const back = sorted[sorted.length - 1];
      const short = nearestByDelta(front, "put", 0.35);
      const long = nearestByDelta(back, "put", 0.55);
      if (!short || !long) return null;
      return [
        { kind: "put", side: "short", qty: 1, strike: short.strike, expiry: short.expiry },
        { kind: "put", side: "long", qty: 1, strike: long.strike, expiry: long.expiry },
      ];
    }
    case "put_front_ratio": {
      const short = nearestByDelta(chain!, "put", 0.16);
      const lng = nearestByDelta(chain!, "put", 0.3);
      if (!short || !lng) return null;
      return [
        { kind: "put", side: "long", qty: 1, strike: lng.strike, expiry: lng.expiry },
        { kind: "put", side: "short", qty: 2, strike: short.strike, expiry: short.expiry },
      ];
    }
    case "call_front_ratio": {
      const short = nearestByDelta(chain!, "call", 0.16);
      const lng = nearestByDelta(chain!, "call", 0.3);
      if (!short || !lng) return null;
      return [
        { kind: "call", side: "long", qty: 1, strike: lng.strike, expiry: lng.expiry },
        { kind: "call", side: "short", qty: 2, strike: short.strike, expiry: short.expiry },
      ];
    }
    case "put_broken_wing_butterfly": {
      for (const d of CREDIT_SEARCH_CENTER_DELTAS) {
        const center = nearestByDelta(chain!, "put", d);
        if (!center) continue;
        if (center.strike + width >= chain!.spot) continue;
        const hi = pickWidth(chain!, "put", center.strike, -width);
        const lo = pickWidth(chain!, "put", center.strike, width * 2);
        if (hi >= chain!.spot) continue;
        const legs: Leg[] = [
          { kind: "put", side: "long", qty: 1, strike: hi, expiry: center.expiry },
          { kind: "put", side: "short", qty: 2, strike: center.strike, expiry: center.expiry },
          { kind: "put", side: "long", qty: 1, strike: lo, expiry: center.expiry },
        ];
        const cAd = absRowDelta(chain!, "put", center.strike);
        if (cAd != null && cAd <= MAX_SHORT_ABS_DELTA && allOptionLegsOtm(chain!, legs)) return legs;
      }
      return null;
    }
    case "call_broken_wing_butterfly": {
      for (const d of CREDIT_SEARCH_CENTER_DELTAS) {
        const center = nearestByDelta(chain!, "call", d);
        if (!center) continue;
        if (center.strike - width <= chain!.spot) continue;
        const lo = pickWidth(chain!, "call", center.strike, -width);
        const hi = pickWidth(chain!, "call", center.strike, width * 2);
        if (lo <= chain!.spot) continue;
        const legs: Leg[] = [
          { kind: "call", side: "long", qty: 1, strike: lo, expiry: center.expiry },
          { kind: "call", side: "short", qty: 2, strike: center.strike, expiry: center.expiry },
          { kind: "call", side: "long", qty: 1, strike: hi, expiry: center.expiry },
        ];
        const cAd = absRowDelta(chain!, "call", center.strike);
        if (cAd != null && cAd <= MAX_SHORT_ABS_DELTA && allOptionLegsOtm(chain!, legs)) return legs;
      }
      return null;
    }
    case "put_broken_heart": {
      const center = nearestByDelta(chain!, "put", 0.4);
      if (!center) return null;
      const kHi = pickWidth(chain!, "put", center.strike, -width);
      const kMidLo = pickWidth(chain!, "put", center.strike, width);
      const kFarLo = pickWidth(chain!, "put", center.strike, width * 2);
      return [
        { kind: "put", side: "long", qty: 1, strike: kHi, expiry: center.expiry },
        { kind: "put", side: "short", qty: 1, strike: center.strike, expiry: center.expiry },
        { kind: "put", side: "short", qty: 1, strike: kMidLo, expiry: center.expiry },
        { kind: "put", side: "long", qty: 1, strike: kFarLo, expiry: center.expiry },
      ];
    }
    case "call_broken_heart": {
      const center = nearestByDelta(chain!, "call", 0.4);
      if (!center) return null;
      const kLo = pickWidth(chain!, "call", center.strike, -width);
      const kMidHi = pickWidth(chain!, "call", center.strike, width);
      const kFarHi = pickWidth(chain!, "call", center.strike, width * 2);
      return [
        { kind: "call", side: "long", qty: 1, strike: kLo, expiry: center.expiry },
        { kind: "call", side: "short", qty: 1, strike: center.strike, expiry: center.expiry },
        { kind: "call", side: "short", qty: 1, strike: kMidHi, expiry: center.expiry },
        { kind: "call", side: "long", qty: 1, strike: kFarHi, expiry: center.expiry },
      ];
    }
    case "short_naked_call": {
      const leg = nearestByDelta(chain!, "call", 0.3);
      if (!leg) return null;
      return [{ kind: "call", side: "short", qty: 1, strike: leg.strike, expiry: leg.expiry }];
    }
    default:
      return null;
  }
}

export const ALL_TEMPLATES: TemplateId[] = [
  "long_stock", "short_stock", "cash_secured_put", "covered_call", "collar",
  "long_call", "long_put", "bull_put_spread", "bear_call_spread",
  "debit_call_vertical", "debit_put_vertical", "iron_condor",
  "long_strangle", "short_strangle", "long_straddle", "short_straddle",
  "calendar", "diagonal", "pmcc",
  "jade_lizard", "iron_fly", "call_zebra", "put_zebra", "put_calendar",
  "call_butterfly", "put_butterfly", "big_lizard", "reverse_big_lizard",
  "covered_put", "put_diagonal", "put_front_ratio", "call_front_ratio",
  "put_broken_wing_butterfly", "call_broken_wing_butterfly",
  "put_broken_heart", "call_broken_heart", "dynamic_iron_condor",
  "short_naked_call", "reverse_jade_lizard",
];
