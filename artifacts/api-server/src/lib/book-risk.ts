/**
 * Jamie 11-20: "you are not looking at the unrealized losses" (stocks −$35k in 2 weeks vs ~−$1k on options) and
 * "should I really be turning margin off? that's like turning it off at the low after using margin at the high."
 *
 * One home for book-level risk on the margin accounts. Pure functions; the route loads the RH snapshot + prices.
 * The question it answers is NOT "will the market fall further" (no tested edge: S-check 11-20 — names down ≥ 25 % in
 * 10 d earned +3.0 % next 20 d vs +1.7 % for the rest, n 1,931, prices since 2025-06) but "how far can SPY fall before
 * the broker sells for you". A forced sale happens at the worst print and is not your choice; that is the risk to size.
 *
 *   dollar beta B = Σ value × beta (120-d daily beta vs SPY)
 *   after an SPY move m: equity falls B·m, loan unchanged → equity ratio = (net − B·m) / (gross − B·m)
 *   call line: ratio < floor (RH 25 % minimum; volatile names carry higher house rates — negative buying power = at the line)
 *   cushion = SPY drop that reaches the floor = (net − floor·gross) / (B·(1 − floor))
 * De-risk: sell in capital-plan order (lib/capital-plan.ts) until the cushion ≥ target (default 10 % SPY drop).
 * Selling S at beta β: gross −S, loan −S, net same, B −β·S → solve for the S that reaches the target.
 */

export const RH_FLOOR = 0.25;
export const CUSHION_TARGET = 0.10;

export type Pt = { date: string; close: number };

/** 120-d daily beta vs SPY on shared dates; null under 40 returns. Clamped to [0, 4] (a thin print can't make it 9). */
export function betaVsSpy(stock: Pt[], spy: Pt[], days = 120): number | null {
  const sp = new Map(spy.map((p) => [p.date, p.close]));
  const pts = stock.filter((p) => sp.has(p.date) && p.close > 0).slice(-(days + 1));
  const a: number[] = [], b: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const s0 = sp.get(pts[i - 1].date)!, s1 = sp.get(pts[i].date)!;
    if (!(s0 > 0)) continue;
    a.push(pts[i].close / pts[i - 1].close - 1);
    b.push(s1 / s0 - 1);
  }
  if (a.length < 40) return null;
  const ma = a.reduce((s, x) => s + x, 0) / a.length, mb = b.reduce((s, x) => s + x, 0) / b.length;
  let cov = 0, vb = 0;
  for (let i = 0; i < a.length; i++) { cov += (a[i] - ma) * (b[i] - mb); vb += (b[i] - mb) ** 2; }
  return vb > 0 ? Math.max(0, Math.min(4, cov / vb)) : null;
}

/** Equity ratio after an SPY move m (m = −0.10 for −10 %). */
export function ratioAfter(net: number, gross: number, dollarBeta: number, m: number): number | null {
  const g = gross + dollarBeta * m;
  return g > 0 ? (net + dollarBeta * m) / g : null;
}

/** SPY drop (positive fraction) that takes the account to the floor; 0 = already there; null = no loan / no beta. */
export function cushion(net: number, gross: number, dollarBeta: number, floor = RH_FLOOR): number | null {
  if (!(dollarBeta > 0) || net >= gross) return null;
  return Math.max(0, (net - floor * gross) / (dollarBeta * (1 - floor)));
}

export type Sellable = { key: string; ticker: string; what: string; cash: number; tier: number; why: string; beta: number };
export type Trim = { ticker: string; what: string; sell: number; ofCash: number; why: string; tier: number; cushionAfter: number | null };

/**
 * Walk `ranked` (capital-plan order) and sell only what is needed for the cushion to reach `target`.
 * Partial last sale: the exact dollar amount, not the whole position.
 */
export function deRisk(net: number, gross: number, dollarBeta: number, loan: number, ranked: Sellable[],
  target = CUSHION_TARGET, floor = RH_FLOOR): { trims: Trim[]; cushionAfter: number | null; reached: boolean } {
  let g = gross, B = dollarBeta, L = loan;
  const trims: Trim[] = [];
  const now = () => cushion(net, g, B, floor);
  for (const s of ranked) {
    const c = now();
    if (c == null || c >= target || L <= 0) break;
    // need S with (net − floor(g − S)) ≥ target(1 − floor)(B − βS)  →  S ≥ [target(1−floor)B − (net − floor·g)] / (floor + target(1−floor)β)
    const need = (target * (1 - floor) * B - (net - floor * g)) / (floor + target * (1 - floor) * s.beta);
    const sell = Math.max(0, Math.min(s.cash, need));
    if (sell <= 0) continue;
    g -= sell; B -= s.beta * sell; L = Math.max(0, L - sell);
    trims.push({ ticker: s.ticker, what: s.what, sell, ofCash: s.cash, why: s.why, tier: s.tier, cushionAfter: now() });
  }
  const after = now();
  return { trims, cushionAfter: after, reached: after == null || after >= target || L <= 0 };
}
