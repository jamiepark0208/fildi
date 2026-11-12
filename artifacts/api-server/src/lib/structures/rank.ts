/**
 * A192 Part L — view × horizon × max-loss ranker (model estimate, not backtested).
 */
import type { OptionsChainResult } from "../options.js";
import { STRUCTURE_EVIDENCE } from "./evidence-map.js";
import { type ChainContext, pickExpiry, priceStructure, payoffAtTime, rationalApproxInvNorm, type Leg } from "./legs.js";
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

/** IV at the strike nearest spot on the horizon expiry (A205 D2: was the first listed strike ≤ spot = deepest OTM). */
export function atmIv(chain: OptionsChainResult | null | undefined): number {
  if (!chain) return 0.25;
  const near = <T extends { strike: number; iv?: number | null }>(xs: T[]) =>
    xs.filter((x) => (x.iv ?? 0) > 0).sort((a, b) => Math.abs(a.strike - chain.spot) - Math.abs(b.strike - chain.spot))[0]?.iv;
  const ivs = [near(chain.puts), near(chain.calls)].filter((v): v is number => v != null);
  return ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0.25;
}

function mcExpectedPnl(
  legs: Leg[],
  ctx: ChainContext,
  netFill: number,
  atMs: number,
  sigma: number,
  earningsBump: number,
): number {
  const spot = ctx.spot;
  const r = ctx.riskFree ?? 0.045;
  const T = Math.max(atMs - Date.now(), 12 * 3600 * 1000) / (365 * 86_400_000);
  const effSigma = sigma * (1 + earningsBump);
  let sum = 0;
  const n = 200;
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    const z = rationalApproxInvNorm(u);
    const ST = spot * Math.exp((r - 0.5 * effSigma * effSigma) * T + effSigma * Math.sqrt(T) * z);
    sum += payoffAtTime(legs, ctx, ST, netFill, atMs);
  }
  return sum / n;
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
  /** structures skipped because a leg has no quote in the stored chain */
  unpriced: TemplateId[];
}> {
  const { chain: anchor, expiryNote } = pickExpiryWithFallback(opts.chains, opts.horizonDays);
  const spot = anchor?.spot ?? opts.chains[0]?.spot ?? 0;
  const ctx: ChainContext = { spot, chains: opts.chains };
  const chainCoverage = chainCoverageSummary(opts.chains);
  const iv = atmIv(anchor ?? opts.chains[0]);
  // A205: no earnings σ bump — the horizon expiry's market IV already prices the event (+25 % on top double-counted:
  // NVDA 30-d long straddle read +$630 vs ≈ −spread). Untested rule, removed.
  const earningsBump = 0;

  const ids = VIEW_TEMPLATES[opts.view] ?? VIEW_TEMPLATES.neutral;
  const rows: RankRow[] = [];
  const unpriced: TemplateId[] = [];

  for (const id of ids) {
    const built = buildTemplate(id, {
      chains: opts.chains,
      horizonDays: opts.horizonDays,
    });
    if (!built?.legs.length) continue;
    const legs = built.legs;
    const priced = priceStructure(legs, ctx, opts.horizonDays);
    // A205 D4: a leg with no chain quote was priced as free (fill 0 → maxLoss 0) — never rank an unquoted structure.
    if (priced.fills.some((f) => f.leg.kind !== "stock" && f.fill === 0 && f.mid === 0)) { unpriced.push(id); continue; }
    if (priced.maxLoss > opts.maxLoss && priced.maxLoss > 0) continue;
    // Payoff is intrinsic at the nearest leg expiry, so the price distribution must stop there too (was the full horizon:
    // a 5-DTE straddle drew 30 days of moves → AAPL long straddle +$2,070).
    // Value everything at the earlier of the horizon and the nearest leg expiry (back legs keep time value — calendars).
    const legEnds = legs.flatMap((l) => (l.kind === "stock" || !l.expiry ? [] : [new Date(`${l.expiry}T16:00:00`).getTime()]));
    const atMs = Math.min(Date.now() + opts.horizonDays * 86_400_000, ...legEnds);
    const expectedPnl = mcExpectedPnl(legs, ctx, priced.netFill, atMs, iv, earningsBump);
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
    unpriced,
  };
}
