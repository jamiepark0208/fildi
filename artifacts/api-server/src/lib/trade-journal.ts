/**
 * A393 trade journal — pure matching + grading (no DB). Route: routes/trade-journal.ts.
 * Grading ports scripts/rec_scoreboard.py: short put P&L = premium − intrinsic at expiry (or last close if open),
 * as % of strike; strike touched = min low in (open, min(expiry, last)] < strike. Split guard: spot vs close > 35 %.
 */

export interface JournalOrder {
  orderId: string;
  at: string; // ISO timestamp
  day: string; // YYYY-MM-DD (ET)
  account: string;
  symbol: string;
  isOption: boolean;
  optionSide: "put" | "call" | null;
  strike: number | null;
  expiry: string | null;
  side: string; // credit|debit|buy|sell
  legEffect: "open" | "close" | null;
  qty: number;
  px: number;
  fees: number | null;
}

export interface Bar { date: string; close: number; low: number }
export type PriceMap = Map<string, Bar[]>; // sorted by date asc

export interface Grade {
  retPct: number | null; // per-share P&L as % of strike
  touched: boolean | null;
  expired: boolean;
  skipped: boolean;
}

export interface JournalRow extends JournalOrder {
  kind: "stock" | "option";
  action: string; // e.g. "sell put open"
  premium: number; // $ cash (option: px*100*qty; stock: px*qty)
  status: "open" | "expired" | "closed" | "closes" | "stock";
  pnl: number | null; // $
  pct: number | null; // % of strike (options)
  touched: boolean | null;
  matchedOpenDay: string | null;
}

const isShortOpen = (o: JournalOrder) => o.isOption && o.legEffect !== "close" && o.side === "credit";
const isLongOpen = (o: JournalOrder) => o.isOption && o.legEffect !== "close" && o.side === "debit";

export function gradeOption(
  o: { optionSide: "put" | "call" | null; strike: number | null; expiry: string | null; px: number; day: string; short: boolean },
  bars: Bar[] | undefined,
  spot?: number | null,
): Grade {
  const bad: Grade = { retPct: null, touched: null, expired: false, skipped: true };
  if (!bars?.length || o.strike == null || !o.expiry || !o.optionSide) return bad;
  const last = bars[bars.length - 1].date;
  const end = o.expiry < last ? o.expiry : last;
  const w = bars.filter((b) => b.date > o.day && b.date <= end);
  const d0 = [...bars].reverse().find((b) => b.date <= o.day);
  if (!w.length || !d0) return bad;
  if (spot != null && spot > 0 && Math.abs(d0.close / spot - 1) > 0.35) return bad;
  const s = w[w.length - 1].close;
  const k = o.strike;
  const intrinsic = o.optionSide === "put" ? Math.max(0, k - s) : Math.max(0, s - k);
  const perShare = o.short ? o.px - intrinsic : intrinsic - o.px;
  const lows = w.map((b) => b.low);
  const touched = o.optionSide === "put" ? Math.min(...lows) < k : Math.max(...w.map((b) => b.close)) > k;
  return { retPct: (perShare / k) * 100, touched, expired: o.expiry <= last, skipped: false };
}

interface Lot { row: JournalRow; left: number }

/** FIFO: closes consume opens of the same contract/account; realized P&L sits on the close row, remainder grading on the open row. */
export function buildJournal(orders: JournalOrder[], prices: PriceMap): JournalRow[] {
  const sorted = [...orders].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const rows: JournalRow[] = sorted.map((o) => ({
    ...o,
    kind: o.isOption ? "option" : "stock",
    action: o.isOption
      ? `${o.side === "credit" ? "sell" : "buy"} ${o.optionSide ?? ""} ${o.legEffect ?? "open"}`.trim()
      : o.side,
    premium: o.px * (o.isOption ? 100 : 1) * o.qty,
    status: o.isOption ? "open" : "stock",
    pnl: null,
    pct: null,
    touched: null,
    matchedOpenDay: null,
  }));
  const lots = new Map<string, Lot[]>();
  const key = (o: JournalOrder) =>
    o.isOption ? `${o.account}|${o.symbol}|${o.optionSide}|${o.strike}|${o.expiry}` : `${o.account}|${o.symbol}`;
  const mult = (o: JournalOrder) => (o.isOption ? 100 : 1);
  for (const r of rows) {
    const k = key(r);
    const opening = r.isOption ? r.legEffect !== "close" : r.side === "buy";
    if (opening) {
      const arr = lots.get(k) ?? [];
      arr.push({ row: r, left: r.qty });
      lots.set(k, arr);
      continue;
    }
    // closing leg: short close = debit close (matches credit open); long close = credit close (matches debit open)
    const arr = (lots.get(k) ?? []).filter((l) => l.left > 0 && (r.isOption ? (r.side === "debit") === isShortOpen(l.row) : true));
    let need = r.qty, pnl = 0, matched = 0;
    for (const l of arr) {
      if (need <= 0) break;
      const take = Math.min(need, l.left);
      const shortLot = r.isOption ? isShortOpen(l.row) : false;
      const per = r.isOption && !shortLot ? r.px - l.row.px : l.row.px - r.px;
      pnl += per * take * mult(r);
      if (!r.matchedOpenDay) r.matchedOpenDay = l.row.day;
      l.left -= take; need -= take; matched += take;
    }
    r.status = r.isOption ? "closes" : "stock";
    if (matched > 0) {
      // fees on the close row only when fees reported
      r.pnl = pnl - (r.fees ?? 0);
      if (r.isOption && r.strike) r.pct = (pnl / (matched * 100) / r.strike) * 100;
    }
    if (r.isOption && r.strike && matched > 0) r.pct = (pnl / (matched * 100) / r.strike) * 100;
  }
  // remainder grading on option opens
  for (const arr of lots.values()) {
    for (const l of arr) {
      const r = l.row;
      if (!r.isOption) continue;
      if (l.left <= 0) { r.status = "closed"; continue; }
      const short = isShortOpen(r);
      const g = gradeOption({ optionSide: r.optionSide, strike: r.strike, expiry: r.expiry, px: r.px, day: r.day, short }, prices.get(r.symbol));
      r.touched = g.touched;
      r.status = g.expired ? "expired" : "open";
      if (g.retPct != null && r.strike) {
        r.pct = g.retPct;
        r.pnl = (g.retPct / 100) * r.strike * 100 * l.left - (r.fees ?? 0);
      }
    }
  }
  return rows;
}

export interface Summary { trades: number; winPct: number | null; pnl: number; avgPct: number | null }

export function summarize(rows: JournalRow[], pick: (r: JournalRow) => boolean = () => true): Summary {
  const w = rows.filter((r) => r.pnl != null && pick(r));
  const pcts = w.filter((r) => r.pct != null);
  return {
    trades: w.length,
    winPct: w.length ? (w.filter((r) => (r.pnl ?? 0) > 0).length / w.length) * 100 : null,
    pnl: w.reduce((s, r) => s + (r.pnl ?? 0), 0),
    avgPct: pcts.length ? pcts.reduce((s, r) => s + (r.pct ?? 0), 0) / pcts.length : null,
  };
}
