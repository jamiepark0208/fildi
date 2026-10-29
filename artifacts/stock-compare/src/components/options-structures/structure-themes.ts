/**
 * Trade-theme grouping for Rankings › Structures (Jamie 10-24).
 * Long stock ≈ bullish ownership / willing to own; Short stock ≈ bearish;
 * Short/Long vol ≈ premium sold/bought; Hedge/time = protect or calendar.
 */
export type TradeTheme = "long_stock" | "short_stock" | "short_vol" | "long_vol" | "hedge";

/** Header row: solid fill + white/black text (never same-hue on tint). */
export const THEME_META: Record<TradeTheme, { label: string; tip: string; headerCls: string }> = {
  long_stock: {
    label: "Long stock",
    tip: "Bullish / willing to own: long calls, sell puts, bullish spreads. S086 long-call angles live under Long call.",
    headerCls: "bg-emerald-700 hover:bg-emerald-600 border-y border-emerald-500",
  },
  short_stock: {
    label: "Short stock",
    tip: "Bearish: long puts, sell calls, bearish spreads. S086 long-put angles live under Long put.",
    headerCls: "bg-red-800 hover:bg-red-700 border-y border-red-500",
  },
  short_vol: {
    label: "Short vol",
    tip: "Sell premium / range: straddles, strangles, condors, flies.",
    headerCls: "bg-violet-700 hover:bg-violet-600 border-y border-violet-400",
  },
  long_vol: {
    label: "Long vol",
    tip: "Buy premium for a big move: long straddle / strangle.",
    headerCls: "bg-sky-600 hover:bg-sky-500 border-y border-sky-400",
  },
  hedge: {
    label: "Hedge / time",
    tip: "Protect a holding or play calendar / skew.",
    headerCls: "bg-orange-700 hover:bg-orange-600 border-y border-orange-400",
  },
};

/** structure id → theme (ids from watchlist_sync/structures.py CATALOG) */
export const STRUCTURE_THEME: Record<string, TradeTheme> = {
  csp: "long_stock",
  long_call: "long_stock",
  bull_call_spread: "long_stock",
  put_spread: "long_stock",
  jade_lizard: "long_stock",
  long_put: "short_stock",
  bear_put_spread: "short_stock",
  call_spread: "short_stock",
  covered_call: "short_stock",
  short_strangle: "short_vol",
  short_straddle: "short_vol",
  iron_condor: "short_vol",
  iron_fly: "short_vol",
  long_straddle: "long_vol",
  long_strangle: "long_vol",
  collar: "hedge",
  calendar: "hedge",
};

/** Plain-English trade shape for hover tips */
export const STRUCTURE_SIMPLE: Record<string, string> = {
  csp: "Sell an OTM put. Cash set aside to buy 100 shares if assigned.",
  covered_call: "Own 100 shares; sell an OTM call against them for income.",
  put_spread: "Sell a put, buy a cheaper put below — defined-risk bullish put sell.",
  call_spread: "Sell a call, buy a more expensive call above — defined-risk bearish call sell.",
  iron_condor: "Sell an OTM put spread + OTM call spread — profit if stock stays in a range.",
  iron_fly: "Sell ATM straddle, buy wings — max profit if stock pins near the strike.",
  jade_lizard: "Sell a put + a call credit spread (credit ≥ call width) — bullish-neutral.",
  short_strangle: "Sell an OTM put and an OTM call — collect premium; undefined risk.",
  short_straddle: "Sell the ATM put and call — collect premium; undefined risk.",
  long_call: "Buy a call — profit if stock rises enough past debit + strike.",
  long_put: "Buy a put — profit if stock falls enough past debit.",
  long_straddle: "Buy ATM put and call — profit on a big move either way.",
  long_strangle: "Buy OTM put and call — cheaper long-vol bet on a large move.",
  bull_call_spread: "Buy a call, sell a higher call — cheaper bullish bet, capped upside.",
  bear_put_spread: "Buy a put, sell a lower put — cheaper bearish bet, capped gain.",
  calendar: "Sell a near-term call, buy a later call same strike — front decays faster.",
  collar: "Own shares; buy a put and sell a call to pay for it — downside hedge, capped upside.",
};

export const THEME_ORDER: TradeTheme[] = [
  "long_stock",
  "short_stock",
  "short_vol",
  "long_vol",
  "hedge",
];

export function themeOf(id: string): TradeTheme {
  return STRUCTURE_THEME[id] ?? "hedge";
}

export function simpleOf(id: string, fallback?: string): string {
  return STRUCTURE_SIMPLE[id] ?? fallback ?? id;
}
