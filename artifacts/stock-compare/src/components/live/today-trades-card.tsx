// Live › Today — one ranked list of every trade the rules pick today (trade funnel step 3, 11-09).
// Order: tier (live strategy > candidate / Strategies board > paper rule), then how many rules agree, then the funnel score
// (all ~900 names model-priced from bars + iv30; chains only for the top). Method in the header tooltip.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH } from "@/lib/score-explain-format";

const TH = cn(GRID_TH, "px-1.5 py-0.5");
const TD = "px-1.5 py-0.5 text-[11px] font-mono";

type Item = {
  rank: number; ticker: string; family: string; structure: string; tier: string; sources: string[];
  strike?: number | null; expiry?: string | null; bid?: number | null; metric?: number | null; metric_label?: string;
  why?: string | null; funnel_score?: number | null; chips?: string[];
};
type Resp = {
  asOf: string | null;
  regime: { label?: string; vix_ratio?: number; allowed?: string[] } | null;
  stages: { stage: string; kept: number; cut: number }[];
  items: Item[];
};

const FAM: Record<string, string> = { short_put: "sell put", long_call: "buy call", long_put: "buy put" };
const TIER_CLS: Record<string, string> = {
  live: "text-green-400", candidate: "text-sky-300", board: "text-sky-300", paper: "text-amber-200/50",
};

export function TodayTradesCard({ n = 15 }: { n?: number }) {
  const [all, setAll] = useState(false);
  const { data } = useQuery<Resp>({
    queryKey: ["trade-funnel-today"],
    queryFn: async () => {
      const r = await fetch("/api/trade-funnel/today", { credentials: "include" });
      if (!r.ok) throw new Error(`trade-funnel ${r.status}`);
      return r.json();
    },
    staleTime: 10 * 60_000,
  });
  if (!data?.asOf || !data.items?.length) return null;
  const uni = data.stages.find((s) => s.stage === "universe");
  const sl = data.stages.find((s) => s.stage === "shortlist");
  const rows = all ? data.items : data.items.slice(0, n);
  const tip =
    "Every name is model-priced from daily bars + 30-day IV (no chain calls), ranked on tested edges (put-edge for sold puts, " +
    "S086 long-option angles for calls/puts) + IV vs realized vol; the market regime only re-weights (S175). Real chains are " +
    "pulled for the shortlist only. The list merges the sold-put engine, the Strategies board and every rule that fired in the " +
    "last 2 signal days; rank = tier, then how many rules agree, then the funnel score.";
  return (
    <section className={cn(GRID_WRAP, "space-y-0.5")} data-testid="today-trades">
      <div className={cn(GRID_HEADER, "flex items-baseline gap-2 px-1.5")} title={tip}>
        <span className="font-semibold">Today</span>
        <span className="text-[10px] text-amber-200/50">
          {data.asOf} · regime {data.regime?.label ?? "—"}
          {data.regime?.vix_ratio != null && ` (VIX÷VIX3M ${data.regime.vix_ratio})`}
          {uni && sl && ` · priced ${uni.kept} → chains ${sl.kept}`} · {data.items.length} picks
        </span>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            {["#", "Ticker", "Trade", "Strike", "Exp", "Tier", "Rules"].map((h) => (
              <th key={h} className={cn(TH, h === "Rules" ? "text-left" : "")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((it) => (
            <tr key={`${it.ticker}-${it.family}`} className="border-t border-white/5" title={it.why ?? undefined}>
              <td className={cn(TD, "text-amber-200/40")}>{it.rank}</td>
              <td className={cn(TD, "text-white")}>{it.ticker}</td>
              <td className={TD}>{FAM[it.family] ?? it.structure}</td>
              <td className={cn(TD, "text-right")}>{it.strike != null ? Number(it.strike).toFixed(1) : "—"}</td>
              <td className={TD}>{it.expiry ? String(it.expiry).slice(5) : "—"}</td>
              <td className={cn(TD, TIER_CLS[it.tier] ?? "")}>{it.tier}</td>
              <td className={cn(TD, "text-left text-amber-200/60 truncate max-w-[260px]")}>
                {it.sources.length > 1 ? `${it.sources.length}: ` : ""}{it.sources.join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.items.length > n && (
        <button className="px-1.5 text-[10px] text-sky-300/70 hover:text-sky-300" onClick={() => setAll(!all)}>
          {all ? "show top " + n : `show all ${data.items.length}`}
        </button>
      )}
    </section>
  );
}
