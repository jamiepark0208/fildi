/**
 * Jamie 11-19: "don't exclude ideas based on capital requirements. Show all trade recommendations; if more capital is
 * required, recommend how best to create it (sell rich positions to make room, weighing risk/reward and odds)."
 *
 * One home for "where would the cash come from". Pure functions; the route loads the latest RH snapshot.
 * Every rec stays visible. Each gets a plan: fits now · or the sells that free the gap, cheapest-to-give-up first.
 *
 * Margin loan (rule 10-06, S012): an account with a loan writes no new puts on borrowed money → the loan is part of
 * the gap (repay first), not a reason to hide the idea.
 *
 * Sell order (tier, lowest first) — rules, not a backtested edge:
 *   0 short put ≥ 50 % of premium captured: little reward left, closing frees its collateral (cash_moves.py order)
 *   1 Model List Avoid / Trim / red: Fildi's own verdict says weak odds
 *   2 long option with < 15 % odds to finish above breakeven (IV lognormal, no drift): a lottery ticket, sell its mark
 *   3 rich: price ≥ fair value or within 10 % of the 52-week high, not green
 *   4 everything else not green
 *   5 green (Fildi would own it) — last; flagged
 * Inside a tier: taxable account loss first (harvest), then least reward per risk (upside to resistance ÷ downside to
 * support), then the bigger sale (fewer trades).
 */

export type Account = { account: string; name: string; cash: number; loan: number; taxable: boolean };
export type Source = {
  account: string; key: string; ticker: string; kind: "close put" | "sell option" | "sell stock";
  what: string; cash: number; tier: number; why: string;
  rr: number | null; pWin: number | null; taxPnl: number | null;
};
export type Need = { id: string; account: string | null; ticker: string; need: number; excludeKeys?: string[] };
export type Plan = {
  account: string; name: string; need: number; cashUsed: number; loanRepaid: number; fits: boolean;
  sells: { what: string; cash: number; why: string; tier: number }[]; shortBy: number; note: string | null;
};

const TIER_NAME = ["≥ 50 % captured", "Model List avoid/trim", "low odds", "rich", "no strong view", "green — Fildi would own it"];

export type StockIn = { account: string; ticker: string; qty: number; px: number; avgCost: number | null;
  folder: string | null; verdict: string | null; p2f: number | null; offHigh: number | null;
  support: number | null; resistance: number | null; lockedShares: number };
export type OptIn = { account: string; ticker: string; type: "call" | "put"; dir: "long" | "short"; strike: number; expiry: string;
  qty: number; mark: number | null; cost: number | null; pBe: number | null };

const usd = (x: number) => `$${Math.round(x).toLocaleString("en-US")}`;

export function stockSource(s: StockIn, taxable: boolean): Source | null {
  const free = s.qty - s.lockedShares;
  if (free <= 0 || !(s.px > 0)) return null;
  const cash = free * s.px;
  const green = s.verdict === "green" || s.folder === "own";
  const weak = s.folder === "avoid" || s.folder === "trim_risk" || s.verdict === "red";
  const rich = (s.p2f != null && s.p2f >= 1) || (s.offHigh != null && s.offHigh >= -0.1);
  const tier = weak ? 1 : green ? 5 : rich ? 3 : 4;
  const up = s.resistance && s.resistance > s.px ? s.resistance / s.px - 1 : null;
  const dn = s.support && s.support < s.px ? 1 - s.support / s.px : null;
  const rr = up != null && dn != null && dn > 0 ? up / dn : null;
  const taxPnl = taxable && s.avgCost != null ? (s.px - s.avgCost) * free : null;
  const bits = [weak ? `Model List ${s.folder === "trim_risk" ? "Trim" : s.folder === "avoid" ? "Avoid" : "red"}`
    : green ? "Fildi rates it green — selling gives up a name it would own"
    : rich ? (s.p2f != null && s.p2f >= 1 ? `at ${s.p2f.toFixed(2)}× fair value` : `${Math.round(-(s.offHigh ?? 0) * 100)} % off its high`)
    : "no strong Fildi view"];
  if (rr != null) bits.push(`upside ${Math.round((up ?? 0) * 100)} % to resistance vs ${Math.round((dn ?? 0) * 100)} % to support (R/R ${rr.toFixed(1)})`);
  if (taxPnl != null) bits.push(taxPnl < 0 ? `books a ${usd(-taxPnl)} tax loss` : `taxable gain ${usd(taxPnl)}`);
  if (s.lockedShares > 0) bits.push(`${s.lockedShares} sh held behind short calls`);
  return { account: s.account, key: `stk:${s.account}:${s.ticker}`, ticker: s.ticker, kind: "sell stock",
    what: `sell ${free % 1 ? free.toFixed(2) : free} ${s.ticker}`, cash, tier, why: bits.join(" · "), rr, pWin: null, taxPnl };
}

export function optionSource(o: OptIn, taxable: boolean): Source | null {
  if (o.mark == null || !(o.qty > 0)) return null;
  const label = `${o.ticker} ${o.strike}${o.type === "call" ? "C" : "P"} ${o.expiry.slice(5)}`;
  if (o.dir === "short") {
    if (o.type !== "put" || !o.cost) return null;
    const captured = 1 - o.mark / o.cost;
    if (captured < 0.5) return null;   // S103: early exits on 2+ week puts lose → only near-done puts are a cash source
    const buyback = o.mark * 100 * o.qty;
    return { account: o.account, key: `opt:${o.account}:${label}`, ticker: o.ticker, kind: "close put", what: `buy back ${label} ×${o.qty}`,
      cash: o.strike * 100 * o.qty - buyback, tier: 0, rr: null, pWin: null, taxPnl: null,
      why: `${Math.round(captured * 100)} % of premium kept · costs ${usd(buyback)}, frees ${usd(o.strike * 100 * o.qty)} of collateral` };
  }
  const cash = o.mark * 100 * o.qty;
  if (cash < 1) return null;
  const tier = o.pBe != null && o.pBe < 0.15 ? 2 : 4;
  const taxPnl = taxable && o.cost != null ? (o.mark - o.cost) * 100 * o.qty : null;
  const why = [o.pBe != null ? `${Math.round(o.pBe * 100)} % odds to finish above breakeven` : "odds unknown (no IV)"];
  if (taxPnl != null) why.push(taxPnl < 0 ? `books a ${usd(-taxPnl)} tax loss` : `taxable gain ${usd(taxPnl)}`);
  return { account: o.account, key: `opt:${o.account}:${label}`, ticker: o.ticker, kind: "sell option", what: `sell ${label} ×${o.qty}`,
    cash, tier, rr: null, pWin: o.pBe, taxPnl, why: why.join(" · ") };
}

/** Cheapest to give up first (see header). */
export function rankSources(src: Source[]): Source[] {
  return [...src].sort((a, b) => a.tier - b.tier
    || (a.taxPnl != null && a.taxPnl < 0 ? 0 : 1) - (b.taxPnl != null && b.taxPnl < 0 ? 0 : 1)
    || (a.rr ?? 99) - (b.rr ?? 99) || b.cash - a.cash);
}

/**
 * Walk the recs in priority order; cash is shared, so an earlier rec uses it up. An account with a loan repays it first.
 * A rec without an account goes where the leftover gap is smallest. Sells cover the gap (last one may overshoot: whole
 * positions; Jamie can sell part). Nothing is ever dropped — a rec the sources can't cover says how short it is.
 */
export function allocate(accounts: Account[], sources: Source[], needs: Need[]): Map<string, Plan> {
  // base = the account's own cash still unspent; cash above it = leftover from sales listed for earlier rows
  const st = new Map(accounts.map((a) => [a.account, { ...a, cash: Math.max(0, a.cash), base: Math.max(0, a.cash), loan: Math.max(0, a.loan),
    q: rankSources(sources.filter((s) => s.account === a.account)) }]));
  const out = new Map<string, Plan>();
  const gapOf = (a: { cash: number; loan: number }, need: number) => need + a.loan - a.cash;
  const sim = (acct: string, n: Need) => {
    const a = st.get(acct)!;
    const ex = new Set(n.excludeKeys ?? []);
    let gap = gapOf(a, n.need);
    const take: Source[] = [];
    for (const s of a.q) {
      if (gap <= 0) break;
      if (ex.has(s.key)) continue;
      take.push(s);
      gap -= s.cash;
    }
    return { a, take, gap: Math.max(0, gap) };
  };
  for (const n of needs) {
    const cands = n.account ? [n.account].filter((x) => st.has(x)) : [...st.keys()];
    if (!cands.length) continue;
    const best = cands.map((acct) => ({ acct, r: sim(acct, n) }))
      .sort((x, y) => x.r.gap - y.r.gap || x.r.take.reduce((s, t) => s + t.tier, 0) - y.r.take.reduce((s, t) => s + t.tier, 0))[0]!;
    const { a, take, gap } = best.r;
    const raised = take.reduce((s, t) => s + t.cash, 0);
    const loanRepaid = Math.min(a.loan, a.cash + raised);
    const cashUsed = Math.min(a.cash, n.need + a.loan);
    const leftover = gap === 0 && n.need + a.loan > a.base + raised;
    const note = [leftover ? "uses cash left over from sales listed for rows above — do those first" : null,
      a.loan > 0 ? `${a.name} carries a ${usd(a.loan)} margin loan → repay it before a new put (rule 10-06)` : null,
      take.some((t) => t.tier === 5) ? "the list reaches a green holding — only if you prefer this trade to that name" : null,
      take.some((t) => t.ticker === n.ticker && (t.taxPnl ?? 0) < 0) ? `selling ${n.ticker} at a loss then selling its put: assignment within 30 days = wash sale` : null,
    ].filter(Boolean).join(" · ") || null;
    out.set(n.id, { account: a.account, name: a.name, need: n.need, cashUsed, loanRepaid, fits: take.length === 0 && gap === 0,
      sells: take.map((t) => ({ what: t.what, cash: Math.round(t.cash), why: `${TIER_NAME[t.tier]}: ${t.why}`, tier: t.tier })),
      shortBy: Math.round(gap), note });
    if (gap > 0) continue;   // can't fund it → don't spend the account's cash on it; later recs keep their chance
    const used = new Set(take.map((t) => t.key));
    a.q = a.q.filter((s) => !used.has(s.key));
    let pool = a.cash + raised;
    const repay = Math.min(a.loan, pool);
    a.loan -= repay; pool -= repay;
    a.cash = Math.max(0, pool - n.need);
    a.base = Math.min(a.base, a.cash);
  }
  return out;
}
