// Sector rotation (relative strength vs SPY). Extracted verbatim from macro-data.ts — no behavior change.
// Proxy only — price-based relative strength, NOT measured dollar flow between
// sectors. Quadrant = RRG-style: rs1m (level) x momentum (rs1m - rs3m, trend).
import YahooFinanceClass from "yahoo-finance2";
const yahooFinance = new YahooFinanceClass();
import type { SectorRotationPoint } from "../macro-data.js";
import { allSettledLimited } from "./macro-utils.js";

// Notable large-cap names per sector for the tooltip — not a precise/live
// top-3-by-weight list (SPDR weights drift and aren't cheaply fetchable),
// just well-known bellwethers so a CSP trader knows where to look.
const SECTOR_ETFS = [
  { ticker: "XLK",  label: "Technology",       movers: ["NVDA", "AAPL", "MSFT"] },
  { ticker: "XLC",  label: "Communications",   movers: ["META", "GOOGL", "NFLX"] },
  { ticker: "XLY",  label: "Consumer Disc.",   movers: ["AMZN", "TSLA", "HD"] },
  { ticker: "XLP",  label: "Consumer Staples", movers: ["COST", "PG", "WMT"] },
  { ticker: "XLE",  label: "Energy",           movers: ["XOM", "CVX", "COP"] },
  { ticker: "XLF",  label: "Financials",       movers: ["JPM", "V", "MA"] },
  { ticker: "XLV",  label: "Health Care",      movers: ["LLY", "UNH", "JNJ"] },
  { ticker: "XLI",  label: "Industrials",      movers: ["GE", "CAT", "RTX"] },
  { ticker: "XLB",  label: "Materials",        movers: ["LIN", "SHW", "FCX"] },
  { ticker: "XLRE", label: "Real Estate",      movers: ["PLD", "AMT", "EQIX"] },
  { ticker: "XLU",  label: "Utilities",        movers: ["NEE", "SO", "DUK"] },
  { ticker: "SMH",  label: "Semiconductors",   movers: ["NVDA", "TSM", "AVGO"] },
];

export async function fetchSectorRotation(): Promise<SectorRotationPoint[]> {
  const now = new Date();
  const period1 = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000);

  const findClose = (quotes: Array<{ date: unknown; close: number | null }>, daysAgo: number): number | null => {
    const targetStr = new Date(now.getTime() - daysAgo * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    let best: number | null = null;
    for (const q of quotes) {
      if (q.close == null) continue;
      const d = (q.date instanceof Date ? q.date : new Date(q.date as string)).toISOString().slice(0, 10);
      if (d <= targetStr) best = q.close;
    }
    return best;
  };

  type Returns = { ret1d: number | null; ret1w: number | null; ret1m: number | null; ret3m: number | null };
  const NULL_RETURNS: Returns = { ret1d: null, ret1w: null, ret1m: null, ret3m: null };

  const fetchReturns = async (ticker: string): Promise<Returns> => {
    const r = await Promise.allSettled([
      yahooFinance.chart(ticker, { period1, interval: "1d" }, { validateResult: false }),
    ]);
    if (r[0].status !== "fulfilled") return NULL_RETURNS;
    const quotes = ((r[0].value as Record<string, unknown>)?.["quotes"] as Array<{ date: unknown; close: number | null }>) ?? [];
    const current  = findClose(quotes, 0);
    const dayAgo   = quotes.length >= 2 ? quotes[quotes.length - 2].close : null;
    const weekAgo  = findClose(quotes, 7);
    const monthAgo = findClose(quotes, 30);
    const threeMonthAgo = findClose(quotes, 91);
    return {
      ret1d: current != null && dayAgo != null && dayAgo !== 0 ? ((current / dayAgo) - 1) * 100 : null,
      ret1w: current != null && weekAgo != null && weekAgo !== 0 ? ((current / weekAgo) - 1) * 100 : null,
      ret1m: current != null && monthAgo != null && monthAgo !== 0 ? ((current / monthAgo) - 1) * 100 : null,
      ret3m: current != null && threeMonthAgo != null && threeMonthAgo !== 0 ? ((current / threeMonthAgo) - 1) * 100 : null,
    };
  };

  const moverTickers = SECTOR_ETFS.flatMap((s) => s.movers);
  const allTickers = ["SPY", ...SECTOR_ETFS.map((s) => s.ticker), ...moverTickers];
  const results = await allSettledLimited(allTickers.map((t) => () => fetchReturns(t)), 6);
  const returnsByTicker = new Map(allTickers.map((t, i) => [t, results[i].status === "fulfilled" ? results[i].value : NULL_RETURNS]));

  const spyReturns = returnsByTicker.get("SPY")!;
  const rsVsSpy = (r: Returns): number | null =>
    r.ret1m != null && spyReturns.ret1m != null ? parseFloat((r.ret1m - spyReturns.ret1m).toFixed(2)) : null;
  const round2 = (n: number | null) => n != null ? parseFloat(n.toFixed(2)) : null;

  return SECTOR_ETFS.map((s) => {
    const sr = returnsByTicker.get(s.ticker)!;
    const { ret1d, ret1m, ret3m } = sr;
    const rs1d = ret1d != null && spyReturns.ret1d != null ? ret1d - spyReturns.ret1d : null;
    const rs1w = sr.ret1w != null && spyReturns.ret1w != null ? sr.ret1w - spyReturns.ret1w : null;
    const rs1m = ret1m != null && spyReturns.ret1m != null ? ret1m - spyReturns.ret1m : null;
    const rs3m = ret3m != null && spyReturns.ret3m != null ? ret3m - spyReturns.ret3m : null;
    const momentum = rs1m != null && rs3m != null ? rs1m - rs3m : null;
    let quadrant: SectorRotationPoint["quadrant"] = null;
    if (rs1m != null && momentum != null) {
      quadrant = rs1m >= 0
        ? (momentum >= 0 ? "leading" : "weakening")
        : (momentum >= 0 ? "improving" : "lagging");
    }
    return {
      ticker: s.ticker, label: s.label,
      ret1d: round2(sr.ret1d), ret1w: round2(sr.ret1w), ret1m: round2(sr.ret1m),
      rs1d: round2(rs1d), rs1w: round2(rs1w), rs1m: round2(rs1m), rs3m: round2(rs3m),
      momentum: round2(momentum),
      quadrant,
      topMovers: s.movers.map((m) => {
        const mr = returnsByTicker.get(m)!;
        return { ticker: m, ret1d: round2(mr.ret1d), ret1w: round2(mr.ret1w), ret1m: round2(mr.ret1m), rs1m: rsVsSpy(mr) };
      }),
    };
  });
}
