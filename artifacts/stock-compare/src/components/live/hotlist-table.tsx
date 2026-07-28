// Opportunities hotlist table + entry verdict cells (extracted from live.tsx).
// Side-aware: dip = crashed/may reverse up (sell puts), rally = squeezed/may reverse down (sell calls).
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { TechnicalRow } from "@/lib/technical-rankings";
import type { RegimeDirection } from "./regime-banner";
import { num, pct, scoreColor } from "./live-format";

export type HotlistSide = "dip" | "rally";

export interface HotlistEntry {
  ticker: string;
  price: number;
  rsi: number;
  ivCurrent: number;
  return5d: number | null;
  stoch: number | null;
  signal: "GO" | "WATCH" | "NO";
  tier: 1 | 2 | 3;
}

export type EntryVerdict = "enter" | "wait" | "avoid";

export interface EntrySignal {
  ticker: string;
  side?: HotlistSide; // pre-side snapshots omit this — treat as "dip"
  price: number;
  direction: RegimeDirection | null;
  score: number;
  verdict: EntryVerdict;
  factors: string[];
}

const VERDICT_STYLE: Record<EntryVerdict, string> = {
  enter: "bg-green-600/20 text-green-400 border-green-600/40",
  wait: "bg-yellow-500/15 text-yellow-400 border-yellow-500/40",
  avoid: "bg-red-600/20 text-red-400 border-red-600/40",
};

export const VERDICT_LABEL: Record<EntryVerdict, string> = { enter: "Enter", wait: "Wait", avoid: "Avoid" };

/** Entry-timing verdict pill + click-to-open factor breakdown, mirroring the regime banner popover. */
function EntryCell({ signal, asOf }: { signal: EntrySignal | undefined; asOf: string | null }) {
  if (!signal) return <span className="text-muted-foreground">—</span>;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className={cn("px-2 py-0.5 rounded border text-[11px] font-semibold transition-colors hover:brightness-125", VERDICT_STYLE[signal.verdict])}>
          {VERDICT_LABEL[signal.verdict]}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0 text-xs bg-zinc-900 border-zinc-600/40" align="center">
        <div className="px-3 py-2 border-b border-amber-500/20 bg-zinc-800/90 flex items-center justify-between gap-2">
          <span className="font-semibold text-white">{signal.ticker} entry timing</span>
          {asOf && <span className="text-zinc-500 font-mono text-[10px]">as of {asOf}</span>}
        </div>
        <div className="p-3 flex flex-col gap-1.5">
          {signal.factors.map((f, i) => (
            <span key={i} className="text-zinc-300 leading-snug font-mono text-[11px]">{f}</span>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SignalBadge({ signal }: { signal: HotlistEntry["signal"] }) {
  const variant = signal === "GO" ? "default" : signal === "WATCH" ? "secondary" : "outline";
  const color = signal === "GO" ? "bg-green-600 text-white" : signal === "WATCH" ? "bg-yellow-500 text-black" : "text-muted-foreground";
  return <Badge variant={variant} className={cn("text-xs", color)}>{signal}</Badge>;
}

// Nearest level between spot and an ~8% OTM strike, from levels the nightly technicals
// job already computed.
// dip:   nearest support BELOW price (swing lows + pivot S1) — cushioned when the support
//        sits ABOVE the put strike (the fall gets caught before reaching the strike).
// rally: nearest resistance ABOVE price (swing highs + pivot R1) — cushioned when the
//        resistance sits BELOW the call strike (the squeeze gets capped before the strike).
function levelContext(row: TechnicalRow | undefined, price: number, side: HotlistSide): { level: number; cushioned: boolean } | null {
  if (!row) return null;
  if (side === "rally") {
    const levels = [num(row.swingHigh20d), num(row.swingHigh50d), num(row.pivotR1)]
      .filter((v): v is number => v != null && v > price);
    if (levels.length === 0) return null;
    const resistance = Math.min(...levels); // lowest level still above price = nearest resistance
    return { level: resistance, cushioned: resistance < price * 1.08 };
  }
  const levels = [num(row.swingLow20d), num(row.swingLow50d), num(row.pivotS1)]
    .filter((v): v is number => v != null && v > 0 && v < price);
  if (levels.length === 0) return null;
  const support = Math.max(...levels); // highest level still below price = nearest support
  return { level: support, cushioned: support > price * 0.92 };
}

export function HotlistTable({
  side,
  entries,
  techRowMap,
  fundScoreMap,
  techScoreMap,
  entryByTicker,
  entryAsOf,
}: {
  side: HotlistSide;
  entries: HotlistEntry[];
  techRowMap: Map<string, TechnicalRow>;
  fundScoreMap: Map<string, number>;
  techScoreMap: Map<string, number>;
  entryByTicker: Map<string, EntrySignal>;
  entryAsOf: string | null;
}) {
  const isRally = side === "rally";
  const levelTitle = isRally
    ? "Nearest resistance above price (swing highs / pivot R1)."
    : "Nearest support below price (swing lows / pivot S1).";
  return (
    <div className="rounded-md border border-zinc-600/40 overflow-hidden bg-zinc-900/70 shadow-lg shadow-black/40">
      <table className="w-full text-sm">
        <thead className="bg-zinc-800/90 text-white">
          <tr className="border-b border-zinc-600/40">
            <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Ticker</th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Price</th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">RSI</th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">IV · Rank</th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">5d Return</th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Stoch</th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">{isRally ? "Resistance" : "Support"}</th>
            <th className="text-center font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">ER</th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Fund Score</th>
            <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Tech Score</th>
            <th className="text-center font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Signal</th>
            <th className="text-center font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Entry</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => {
            const fundScore = fundScoreMap.get(e.ticker) ?? null;
            const techScore = techScoreMap.get(e.ticker) ?? null;
            const tech = techRowMap.get(e.ticker);
            const ivRank = num(tech?.ivRank); // [0,1] self-relative
            const level = levelContext(tech, e.price, side);
            const erDays = tech?.earningsDaysOut ?? null;
            const erSoon = erDays != null && erDays >= 0 && erDays <= 7;
            const knife = !isRally && tech?.fallingKnife === 1;
            const rsiExtreme = isRally ? e.rsi > 70 : e.rsi < 30; // the setup on each side
            return (
              <tr key={e.ticker} className="bg-zinc-900/40 even:bg-zinc-800/40 hover:bg-zinc-700/50 transition-colors">
                <td className="px-3 py-1.5 font-mono font-semibold text-white">
                  {e.ticker}
                  {knife && <span className="ml-1 text-red-500" title="Falling knife: >2 ATR below MA50 and MA200 with MACD falling">⚠</span>}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-white">{e.price.toFixed(2)}</td>
                <td className={cn("px-3 py-1.5 text-right font-mono", rsiExtreme ? "text-green-400 font-semibold" : "text-white")}>
                  {e.rsi.toFixed(1)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-amber-400">
                  {e.ivCurrent.toFixed(0)}%
                  <span className={cn("ml-1", ivRank != null && ivRank >= 0.7 ? "text-amber-300 font-semibold" : "text-zinc-500")}>
                    {ivRank != null ? `R${Math.round(ivRank * 100)}` : ""}
                  </span>
                </td>
                <td className={cn("px-3 py-1.5 text-right font-mono", (e.return5d ?? 0) < 0 ? "text-red-400" : "text-green-400")}>
                  {pct(e.return5d)}
                </td>
                <td className="px-3 py-1.5 text-right font-mono text-white">{e.stoch != null ? e.stoch.toFixed(0) : "—"}</td>
                <td
                  className="px-3 py-1.5 text-right font-mono text-zinc-300"
                  title={level
                    ? `${levelTitle} ${level.cushioned
                        ? (isRally ? "An ~8% OTM call strike would sit ABOVE this resistance (capped before the strike)." : "An ~8% OTM put strike would sit BELOW this support (cushioned).")
                        : (isRally ? "An ~8% OTM call strike would sit BELOW this resistance (no cap before the strike)." : "An ~8% OTM put strike would sit ABOVE this support (no cushion).")}`
                    : undefined}
                >
                  {level ? (
                    <>
                      {level.level.toFixed(2)}
                      <span className={cn("ml-1 font-semibold", level.cushioned ? "text-green-400" : "text-red-400")}>
                        {level.cushioned ? "✓" : "✗"}
                      </span>
                    </>
                  ) : "—"}
                </td>
                <td className="px-3 py-1.5 text-center">
                  {erSoon ? (
                    <span className="px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/15 text-amber-400 text-[10px] font-semibold" title={`Earnings in ${erDays} day${erDays === 1 ? "" : "s"}`}>
                      {erDays}d
                    </span>
                  ) : (
                    <span className="text-zinc-600 text-[10px]">{erDays != null ? `${erDays}d` : "—"}</span>
                  )}
                </td>
                <td className={cn("px-3 py-1.5 text-right font-mono", scoreColor(fundScore))}>
                  {fundScore != null ? fundScore.toFixed(0) : "—"}
                </td>
                <td className={cn("px-3 py-1.5 text-right font-mono", scoreColor(techScore))}>
                  {techScore != null ? techScore.toFixed(0) : "—"}
                </td>
                <td className="px-3 py-1.5 text-center"><SignalBadge signal={e.signal} /></td>
                <td className="px-3 py-1.5 text-center"><EntryCell signal={entryByTicker.get(e.ticker)} asOf={entryAsOf} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
