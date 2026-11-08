/**
 * A192 Part L — view × horizon × max-loss ranker (model estimate, not backtested).
 */
import type { OptionsChainResult } from "../options.js";
import { getUpcomingEarningsDates } from "../earnings-history.js";
import { STRUCTURE_EVIDENCE } from "./evidence-map.js";
import { type ChainContext, pickExpiry, priceStructure, payoffAtSpot, type Leg } from "./legs.js";
import { TEMPLATE_LABELS, buildTemplate, type TemplateId } from "./templates.js";

export type MarketView = "bull" | "bear" | "neutral" | "vol_up" | "vol_down";

const VIEW_TEMPLATES: Record<MarketView, TemplateId[]> = {
  bull: ["long_stock", "long_call", "bull_put_spread", "covered_call", "pmcc", "debit_call_vertical", "cash_secured_put"],
  bear: ["long_put", "bear_call_spread", "short_stock", "debit_put_vertical"],
  neutral: ["iron_condor", "short_strangle", "cash_secured_put", "covered_call", "collar", "calendar"],
  vol_up: ["long_straddle", "long_strangle", "calendar", "diagonal"],
  vol_down: ["short_straddle", "short_strangle", "iron_condor", "bull_put_spread"],
};

export interface RankRow {
  id: TemplateId;
  name: string;
  legs: Leg[];
  netFill: number;
  expectedPnl: number;
  pnlPerBp: number;
  pop: number;
  maxLoss: number;
  worstCase: number;
  buyingPower: number;
  evidence: (typeof STRUCTURE_EVIDENCE)[string] | null;
  label: string;
}

function atmIv(chains: OptionsChainResult[]): number {
  const c = chains[0];
  if (!c) return 0.25;
  const put = c.puts.find((p) => p.strike <= c.spot) ?? c.puts[0];
  const call = c.calls.find((x) => x.strike >= c.spot) ?? c.calls[0];
  return ((put?.iv ?? 0.25) + (call?.iv ?? 0.25)) / 2;
}

function mcExpectedPnl(
  legs: Leg[],
  ctx: ChainContext,
  netFill: number,
  horizonDays: number,
  sigma: number,
  earningsBump: number,
): number {
  const spot = ctx.spot;
  const r = ctx.riskFree ?? 0.045;
  const T = horizonDays / 365;
  const effSigma = sigma * (1 + earningsBump);
  let sum = 0;
  const n = 200;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const z = invNorm(u);
    const ST = spot * Math.exp((r - 0.5 * effSigma * effSigma) * T + effSigma * Math.sqrt(T) * z);
    sum += payoffAtSpot(legs, ctx, ST, netFill, true);
  }
  return sum / n;
}

function invNorm(p: number): number {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
  const b = [-5.4e1, 1.6e2, -1.5e2, 6.0e1, -1.0e1];
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export interface ChainExpiryCoverage {
  expiry: string;
  daysToExpiry: number;
  puts: boolean;
  calls: boolean;
}

export function chainCoverageSummary(chains: OptionsChainResult[]): ChainExpiryCoverage[] {
  return [...chains]
    .sort((a, b) => a.daysToExpiry - b.daysToExpiry)
    .map((c) => ({
      expiry: c.expiry,
      daysToExpiry: c.daysToExpiry,
      puts: c.puts.length > 0,
      calls: c.calls.length > 0,
    }));
}

/** Nearest expiry to horizon with both sides; else nearest both-sided in full chain. */
export function pickExpiryWithFallback(
  chains: OptionsChainResult[],
  horizonDays: number,
): { chain: OptionsChainResult | null; expiryNote: string | null } {
  const minDte = Math.max(0, horizonDays - 7);
  const bothSides = (list: OptionsChainResult[]) =>
    list.filter((c) => c.puts.length > 0 && c.calls.length > 0);

  let pool = bothSides(chains.filter((c) => c.daysToExpiry >= minDte));
  let usedFallback = false;
  if (!pool.length) {
    pool = bothSides(chains);
    usedFallback = pool.length > 0;
  }
  if (!pool.length) {
    const anchor = pickExpiry(chains, horizonDays) ?? chains[0] ?? null;
    return { chain: anchor, expiryNote: anchor ? `horizon not available — used ${anchor.daysToExpiry} DTE` : null };
  }
  const chain = pickExpiry(pool, horizonDays) ?? pool[0];
  const inWindow = chain.daysToExpiry >= minDte && !usedFallback;
  const expiryNote = inWindow
    ? null
    : `horizon not available — used ${chain.daysToExpiry} DTE`;
  return { chain, expiryNote };
}

export async function rankStructuresForView(opts: {
  ticker: string;
  chains: OptionsChainResult[];
  view: MarketView;
  horizonDays: number;
  maxLoss: number;
}): Promise<{
  ticker: string;
  view: MarketView;
  horizonDays: number;
  maxLoss: number;
  label: string;
  expiryNote: string | null;
  chainCoverage: ChainExpiryCoverage[];
  rows: RankRow[];
}> {
  const { chain: anchor, expiryNote } = pickExpiryWithFallback(opts.chains, opts.horizonDays);
  const spot = anchor?.spot ?? opts.chains[0]?.spot ?? 0;
  const ctx: ChainContext = { spot, chains: opts.chains };
  const chainCoverage = chainCoverageSummary(opts.chains);
  const iv = atmIv(opts.chains);
  let earningsBump = 0;
  const upcoming = await getUpcomingEarningsDates([opts.ticker]);
  const er = upcoming[opts.ticker.toUpperCase()];
  if (er) {
    const days = (new Date(er).getTime() - Date.now()) / 86_400_000;
    if (days >= 0 && days <= opts.horizonDays) earningsBump = 0.25;
  }

  const ids = VIEW_TEMPLATES[opts.view] ?? VIEW_TEMPLATES.neutral;
  const rows: RankRow[] = [];

  for (const id of ids) {
    const legs = buildTemplate(id, {
      chains: opts.chains,
      horizonDays: opts.horizonDays,
    });
    if (!legs?.length) continue;
    const priced = priceStructure(legs, ctx, opts.horizonDays);
    if (priced.maxLoss > opts.maxLoss && priced.maxLoss > 0) continue;
    const expectedPnl = mcExpectedPnl(legs, ctx, priced.netFill, opts.horizonDays, iv, earningsBump);
    const bp = priced.buyingPower || 1;
    rows.push({
      id,
      name: TEMPLATE_LABELS[id],
      legs,
      netFill: priced.netFill,
      expectedPnl,
      pnlPerBp: expectedPnl / bp,
      pop: priced.pop,
      maxLoss: priced.maxLoss,
      worstCase: -priced.maxLoss,
      buyingPower: bp,
      evidence: STRUCTURE_EVIDENCE[id] ?? null,
      label: "model estimate — not backtested",
    });
  }

  rows.sort((a, b) => b.pnlPerBp - a.pnlPerBp);

  const label =
    expiryNote != null
      ? `model estimate — not backtested · ${expiryNote}`
      : "model estimate — not backtested";

  return {
    ticker: opts.ticker,
    view: opts.view,
    horizonDays: opts.horizonDays,
    maxLoss: opts.maxLoss,
    label,
    expiryNote,
    chainCoverage,
    rows,
  };
}
