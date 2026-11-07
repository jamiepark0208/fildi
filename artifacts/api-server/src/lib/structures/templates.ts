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
  | "pmcc";

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
];
