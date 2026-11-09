// Live › Top Puts — the proven put lanes from today's Model List run (11-09: replaced the option-score
// "Best strikes" list, which ranked AAPL 0.12 %/wk on top; S014: option_score adds ~0 over IV).
// Rows: engine picks (sell_puts: every L1/L2 gate passed) first, then the S109 rich-put lane
// (≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high), with the S054 panic tag where it fires.
import { cn } from "@/lib/utils";
import { useModelList, type ModelListItem } from "@/hooks/use-model-list";
import { useActivePanicPutBadges } from "@/hooks/use-strategy-signals";
import { RecConflictChip } from "./rec-conflict-chip";
import type { RecConflict } from "@/lib/rec-conflicts";
import type { RegimeRisk } from "./regime-banner";
import { GRID_WRAP, GRID_HEADER, GRID_TH } from "@/lib/score-explain-format";

const TH = cn(GRID_TH, "px-1.5 py-0.5");
const TD = "px-1.5 py-0.5 text-[11px] font-mono";

type Rich = { otm_pct?: number; spot?: number; off_high_pct?: number; tier?: string; earnings_in?: boolean };
type Contract = NonNullable<ModelListItem["contract"]> & {
  delta?: number; weekly_income_pct?: number; rich?: Rich; earnings?: { date: string; inside: boolean };
  win?: { delta?: number };
};

type Row = { item: ModelListItem; lane: "pick" | "rich"; c: Contract };

const fmt = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: v < 10 ? 2 : 1, maximumFractionDigits: v < 10 ? 2 : 1 });

export function ProvenPutsTable({
  n = 12,
  regimeRisk = null,
  conflictsByTicker,
}: {
  n?: number;
  regimeRisk?: RegimeRisk | null;
  conflictsByTicker?: Map<string, RecConflict[]>;
}) {
  const { data, isFetching } = useModelList();
  const { byTicker: panicByTicker } = useActivePanicPutBadges(3);
  const folder = (k: string) => data?.folders.find((f) => f.key === k)?.items ?? [];
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const [lane, key] of [["pick", "sell_puts"], ["rich", "rich_puts"]] as const) {
    for (const item of [...folder(key)].sort((a, b) => a.rank - b.rank)) {
      const c = item.contract as Contract | null;
      if (!c || c.type !== "put" || seen.has(item.ticker)) continue;
      seen.add(item.ticker);
      rows.push({ item, lane, c });
    }
  }
  const picks = rows.filter((r) => r.lane === "pick").length;
  const shown = rows.slice(0, Math.max(n, picks));
  const runAt = data?.run?.createdAt;
  const softCaution = regimeRisk != null && (regimeRisk.level === "stormy" || regimeRisk.level === "elevated");

  return (
    <div className="space-y-1.5">
      {softCaution && (
        <p className="text-[10px] text-amber-300/80 border border-amber-500/25 rounded px-1.5 py-0.5 bg-amber-500/5">
          Drop risk {({ calm: "low", normal: "average", elevated: "up", stormy: "high" } as const)[regimeRisk!.level]}: {Math.round(regimeRisk!.pDropHalfAtr * 100)}% odds SPY/QQQ fall a further ≥ {regimeRisk!.halfAtrPct.toFixed(2)}% before the close (S126) — size and strike with that in mind.
        </p>
      )}
      {shown.length === 0 ? (
        <p className="text-[11px] text-amber-100/70">{isFetching ? "Loading Model List…" : "No put passes a proven lane today."}</p>
      ) : (
        <div className={GRID_WRAP}>
          <div className={cn(GRID_HEADER, "px-2 py-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5")}>
            <h3
              className="text-[10px] font-semibold text-[#d4af37] uppercase tracking-widest"
              title={"pick = engine pick, every gate passed (Model List › Sell puts)\nrich = S109 rich-put lane: ≥ 0.9 %/wk, ≥ 10 % OTM, ≥ 25 % off high — backtest +101 vs +34 bp/wk same weeks, t 5.7; shadow (live record not graded yet)\npanic = S054: ≥ 2σ 5-day drop + IV30 > 48.7 — kept +4.05 % vs +0.26 %"}
            >
              Proven puts · {picks} pick{picks === 1 ? "" : "s"} + rich lane
            </h3>
            <span className="text-[9px] font-mono text-amber-100/80" title="Model List run (chain snapshot ~10:30 ET) — re-check the live bid before selling">
              Model List {runAt ? new Date(runAt).toLocaleString("en-US", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—"}
            </span>
          </div>
          <table className="w-full">
            <thead className="bg-black/60 text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/15">
                <th className={cn(TH, "text-left")}>Ticker</th>
                <th className={cn(TH, "text-right")}>Px</th>
                <th className={cn(TH, "text-right")}>Strike</th>
                <th className={cn(TH, "text-right")}>Exp</th>
                <th className={cn(TH, "text-right")}>Bid</th>
                <th className={cn(TH, "text-right")}>%/wk</th>
                <th className={cn(TH, "text-right")}>OTM</th>
                <th className={cn(TH, "text-right")}>Δ</th>
                <th className={cn(TH, "text-right")} title="% below the 52-week high">Off hi</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {shown.map(({ item, lane, c }) => {
                const t = item.ticker.toUpperCase();
                const r = c.rich ?? {};
                const spot = r.spot ?? item.close ?? null;
                // engine picks carry no %/wk or Δ: bid ÷ strike per week to expiry; Δ from the win-rate cell
                const days = Math.max(1, (Date.parse(`${c.expiry}T16:00:00-05:00`) - Date.now()) / 86_400_000);
                const wk = c.weekly_income_pct ?? (c.premium != null && c.strike > 0 ? (c.premium / c.strike) * 100 / Math.max(days / 7, 1 / 7) : null);
                const delta = c.delta ?? (c.win?.delta != null ? -Math.abs(c.win.delta) : null);
                const otm = r.otm_pct ?? (spot ? (1 - c.strike / spot) * 100 : null);
                const er = c.earnings?.inside;
                const panic = panicByTicker.get(t);
                return (
                  <tr key={`${lane}:${t}`} className="bg-zinc-900/60 even:bg-zinc-900/30 hover:bg-amber-500/10 transition-colors" title={(item.why ?? []).join("\n")}>
                    <td className={cn(TD, "font-semibold text-white whitespace-nowrap")}>
                      {t}
                      <span
                        className={cn(
                          "ml-1 text-[8px] font-bold rounded px-0.5 border",
                          lane === "pick" ? "text-green-300 border-green-400/50 bg-green-500/15" : "text-emerald-300 border-emerald-400/40",
                        )}
                      >
                        {lane === "pick" ? "PICK" : `rich #${item.rank}`}
                      </span>
                      {panic && (
                        <span className="ml-1 text-[8px] font-semibold text-fuchsia-300 border border-fuchsia-400/40 rounded px-0.5" title={panic.trigger || "S054 panic put"}>
                          panic
                        </span>
                      )}
                      {er && (
                        <span className="ml-1 text-[8px] font-semibold text-orange-300 border border-orange-400/40 rounded px-0.5" title={`Earnings ${c.earnings?.date} before expiry`}>
                          ER
                        </span>
                      )}
                      <RecConflictChip compact conflicts={conflictsByTicker?.get(t) ?? []} />
                    </td>
                    <td className={cn(TD, "text-right text-green-500 font-semibold")}>{spot != null ? fmt(spot) : "—"}</td>
                    <td className={cn(TD, "text-right text-amber-400")}>{fmt(c.strike)}</td>
                    <td className={cn(TD, "text-right text-sky-300/80 whitespace-nowrap")}>{c.expiry.slice(5)}</td>
                    <td className={cn(TD, "text-right text-sky-300/70")}>{c.premium != null ? c.premium.toFixed(2) : "—"}</td>
                    <td className={cn(TD, "text-right text-green-500 font-semibold")}>{wk != null ? wk.toFixed(2) : "—"}</td>
                    <td className={cn(TD, "text-right text-white/80")}>{otm != null ? otm.toFixed(1) : "—"}</td>
                    <td className={cn(TD, "text-right text-sky-300/70")}>{delta != null ? delta.toFixed(2) : "—"}</td>
                    <td className={cn(TD, "text-right text-white/70")}>{r.off_high_pct != null ? `${Math.abs(r.off_high_pct).toFixed(0)}%` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
