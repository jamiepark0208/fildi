/**
 * A192 Part L — named templates from stored chain (deltas / width).
 */
import type { OptionsChainResult } from "../options.js";
import type { Leg } from "./legs.js";
import { pickExpiry } from "./legs.js";

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

export function buildTemplate(id: TemplateId, opts: BuildOpts): Leg[] | null {
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
      const atm = chain!.puts.reduce((a, b) =>
        Math.abs(b.strike - chain!.spot) < Math.abs(a.strike - chain!.spot) ? b : a,
      );
      return [
        { kind: "call", side: "long", qty: 1, strike: atm.strike, expiry: chain!.expiry },
        { kind: "put", side: "long", qty: 1, strike: atm.strike, expiry: chain!.expiry },
      ];
    }
    case "short_straddle": {
      const atm = chain!.puts.reduce((a, b) =>
        Math.abs(b.strike - chain!.spot) < Math.abs(a.strike - chain!.spot) ? b : a,
      );
      return [
        { kind: "call", side: "short", qty: 1, strike: atm.strike, expiry: chain!.expiry },
        { kind: "put", side: "short", qty: 1, strike: atm.strike, expiry: chain!.expiry },
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
      const sorted = [...opts.chains].sort((a, b) => a.daysToExpiry - b.daysToExpiry);
      if (sorted.length < 2) return null;
      const front = sorted[0];
      const back = sorted[Math.min(1, sorted.length - 1)];
      const atm = front.puts.reduce((a, b) =>
        Math.abs(b.strike - front.spot) < Math.abs(a.strike - front.spot) ? b : a,
      );
      return [
        { kind: "call", side: "short", qty: 1, strike: atm.strike, expiry: front.expiry },
        { kind: "call", side: "long", qty: 1, strike: atm.strike, expiry: back.expiry },
      ];
    }
    case "diagonal": {
      const sorted = [...opts.chains].sort((a, b) => a.daysToExpiry - b.daysToExpiry);
      if (sorted.length < 2) return null;
      const front = sorted[0];
      const back = sorted[sorted.length - 1];
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
      const atm = chain!.puts.reduce((a, b) =>
        Math.abs(b.strike - chain!.spot) < Math.abs(a.strike - chain!.spot) ? b : a,
      );
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
      const deep = nearestByDelta(chain!, "call", 0.85);
      if (!deep) return null;
      return [{ kind: "call", side: "long", qty: 1, strike: deep.strike, expiry: deep.expiry }];
    }
    case "put_zebra": {
      const deep = nearestByDelta(chain!, "put", 0.85);
      if (!deep) return null;
      return [{ kind: "put", side: "long", qty: 1, strike: deep.strike, expiry: deep.expiry }];
    }
    case "put_calendar": {
      const sorted = [...opts.chains].sort((a, b) => a.daysToExpiry - b.daysToExpiry);
      if (sorted.length < 2) return null;
      const front = sorted[0];
      const back = sorted[1];
      const atm = front.puts.reduce((a, b) =>
        Math.abs(b.strike - front.spot) < Math.abs(a.strike - front.spot) ? b : a,
      );
      return [
        { kind: "put", side: "short", qty: 1, strike: atm.strike, expiry: front.expiry },
        { kind: "put", side: "long", qty: 1, strike: atm.strike, expiry: back.expiry },
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
      const sPut = nearestByDelta(chain!, "put", 0.25);
      const sCall = nearestByDelta(chain!, "call", 0.16);
      if (!sPut || !sCall) return null;
      return [
        { kind: "put", side: "short", qty: 1, strike: sPut.strike, expiry: sPut.expiry },
        { kind: "call", side: "short", qty: 1, strike: sCall.strike, expiry: sCall.expiry },
      ];
    }
    case "reverse_big_lizard": {
      const sCall = nearestByDelta(chain!, "call", 0.25);
      const sPut = nearestByDelta(chain!, "put", 0.16);
      if (!sCall || !sPut) return null;
      return [
        { kind: "call", side: "short", qty: 1, strike: sCall.strike, expiry: sCall.expiry },
        { kind: "put", side: "short", qty: 1, strike: sPut.strike, expiry: sPut.expiry },
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
      const short = nearestByDelta(chain!, "put", 0.25);
      if (!short) return null;
      const longK = pickWidth(chain!, "put", short.strike, width * 2);
      return [
        { kind: "put", side: "short", qty: 2, strike: short.strike, expiry: short.expiry },
        { kind: "put", side: "long", qty: 1, strike: longK, expiry: short.expiry },
      ];
    }
    case "call_front_ratio": {
      const short = nearestByDelta(chain!, "call", 0.25);
      if (!short) return null;
      const longK = pickWidth(chain!, "call", short.strike, width * 2);
      return [
        { kind: "call", side: "short", qty: 2, strike: short.strike, expiry: short.expiry },
        { kind: "call", side: "long", qty: 1, strike: longK, expiry: short.expiry },
      ];
    }
    case "put_broken_wing_butterfly": {
      const center = nearestByDelta(chain!, "put", 0.45);
      if (!center) return null;
      const lo = pickWidth(chain!, "put", center.strike, width);
      const hi = pickWidth(chain!, "put", center.strike, width * 2);
      return [
        { kind: "put", side: "long", qty: 1, strike: lo, expiry: center.expiry },
        { kind: "put", side: "short", qty: 2, strike: center.strike, expiry: center.expiry },
        { kind: "put", side: "long", qty: 1, strike: hi, expiry: center.expiry },
      ];
    }
    case "call_broken_wing_butterfly": {
      const center = nearestByDelta(chain!, "call", 0.45);
      if (!center) return null;
      const lo = pickWidth(chain!, "call", center.strike, width * 2);
      const hi = pickWidth(chain!, "call", center.strike, width);
      return [
        { kind: "call", side: "long", qty: 1, strike: lo, expiry: center.expiry },
        { kind: "call", side: "short", qty: 2, strike: center.strike, expiry: center.expiry },
        { kind: "call", side: "long", qty: 1, strike: hi, expiry: center.expiry },
      ];
    }
    case "put_broken_heart": {
      const center = nearestByDelta(chain!, "put", 0.4);
      if (!center) return null;
      const lo = pickWidth(chain!, "put", center.strike, width);
      const hi = pickWidth(chain!, "put", center.strike, width * 1.5);
      return [
        { kind: "put", side: "long", qty: 1, strike: lo, expiry: center.expiry },
        { kind: "put", side: "short", qty: 2, strike: center.strike, expiry: center.expiry },
        { kind: "put", side: "long", qty: 1, strike: hi, expiry: center.expiry },
      ];
    }
    case "call_broken_heart": {
      const center = nearestByDelta(chain!, "call", 0.4);
      if (!center) return null;
      const lo = pickWidth(chain!, "call", center.strike, width * 1.5);
      const hi = pickWidth(chain!, "call", center.strike, width);
      return [
        { kind: "call", side: "long", qty: 1, strike: lo, expiry: center.expiry },
        { kind: "call", side: "short", qty: 2, strike: center.strike, expiry: center.expiry },
        { kind: "call", side: "long", qty: 1, strike: hi, expiry: center.expiry },
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
