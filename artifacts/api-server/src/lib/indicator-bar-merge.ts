/** Date-keyed OHLCV merges (A83 split from indicators.ts). */

export type YahooBar = {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type SourcedBar = YahooBar & { source: "schwab" | "yahoo" | "lseg" };

export function barYmd(b: YahooBar): string {
  return b.date.toISOString().slice(0, 10);
}

/** Merge by date: Schwab wins on conflict; Yahoo fills dates Schwab lacks. */
export function mergeSchwabYahoo(schwab: YahooBar[], yahoo: YahooBar[]): SourcedBar[] {
  const byDate = new Map<string, SourcedBar>();
  for (const b of yahoo) byDate.set(barYmd(b), { ...b, source: "yahoo" });
  for (const b of schwab) byDate.set(barYmd(b), { ...b, source: "schwab" });
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}

/** Prefer Yahoo/Schwab OHLC; fill missing/newer dates from LSEG. */
export function mergeYahooLseg(
  yahoo: (YahooBar & { source?: SourcedBar["source"] })[],
  lseg: YahooBar[],
): SourcedBar[] {
  const byDate = new Map<string, SourcedBar>();
  for (const b of lseg) byDate.set(barYmd(b), { ...b, source: "lseg" });
  for (const b of yahoo) byDate.set(barYmd(b), { ...b, source: b.source ?? "yahoo" });
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => v);
}
