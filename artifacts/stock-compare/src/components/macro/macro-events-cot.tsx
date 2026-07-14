import { useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  Legend, ReferenceLine, BarChart, Bar,
} from "recharts";
import { Activity, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MacroEvent, COTRecord, COTSummary, VolatilitySignal } from "./macro-page-types";
import { fmtDate, fmtCot, importanceBadgeClass, matchEventIndicatorKey } from "./macro-format";

// ── Event row ───────────────────────────────────────────────────────────────────

export function EventRow({
  event, todayStr, onJumpToIndicator,
}: {
  event: MacroEvent;
  todayStr: string;
  onJumpToIndicator?: (indicatorKey: string) => void;
}) {
  const isToday = event.date === todayStr;
  const indicatorKey = onJumpToIndicator ? matchEventIndicatorKey(event.event) : undefined;
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-md border border-border text-sm",
        isToday && "border-l-2 border-l-primary bg-primary/5",
        indicatorKey && "cursor-pointer hover:bg-secondary/40 transition-colors"
      )}
      onClick={indicatorKey ? () => onJumpToIndicator!(indicatorKey) : undefined}
      title={indicatorKey ? "View indicator history on Regime tab" : undefined}
    >
      <span className="text-[11px] text-muted-foreground font-medium w-12 shrink-0">
        {fmtDate(event.date)}
      </span>
      <span className="flex-1 text-xs">{event.event}</span>
      <span
        className={cn(
          "text-[10px] px-2 py-0.5 rounded-full font-medium capitalize",
          importanceBadgeClass(event.importance)
        )}
      >
        {event.importance}
      </span>
    </div>
  );
}

// ── COT Section (compact, embedded in Macro tabs) ──────────────────────────────

// Plain-English synthesis of what the raw HF Net / WoW / Z-Score / Open Interest
// figures below actually mean for the selected instrument, so the numbers aren't
// presented without context.
// Shared with CrossTabReadRow so the Regime tab badge and this prose stay in sync.
export function getCotCrowding(selected: COTSummary): { level: VolatilitySignal["level"]; label: string; direction: "long" | "short" } {
  const net = selected.latest.levMoneyNet;
  const absZ = Math.abs(selected.zScore);
  const direction = net >= 0 ? "long" : "short";
  const level: VolatilitySignal["level"] = absZ > 1.5 ? "stress" : absZ > 1 ? "elevated" : "calm";
  const label = absZ > 1.5 ? `Crowded ${direction}` : absZ > 1 ? `Building ${direction}` : "Typical range";
  return { level, label, direction };
}

function CotPositioningRead({ selected }: { selected: COTSummary }) {
  const net = selected.latest.levMoneyNet;
  const chg = selected.latest.levMoneyLongChg - selected.latest.levMoneyShortChg;
  const oi = selected.latest.openInterest;
  const z = selected.zScore;
  const absZ = Math.abs(z);
  const pctOfOI = oi > 0 ? (Math.abs(net) / oi) * 100 : null;

  const { direction } = getCotCrowding(selected);
  const flowVerb = net === 0 || chg === 0 ? null
    : Math.sign(chg) === Math.sign(net) ? "adding to" : "trimming";

  const crowding = absZ > 1.5 ? "historically stretched" : absZ > 1 ? "moderately elevated" : "within a typical range";

  const implication = absZ > 1.5
    ? (net >= 0
        ? "That's a crowded long — a level from which hedge funds have historically been forced to unwind quickly, which can accelerate a selloff if sentiment turns."
        : "That's a crowded short — a level from which short-covering has historically sparked sharp rallies if the market turns higher.")
    : absZ > 1
      ? "Positioning is building in one direction but hasn't reached a historically crowded extreme yet."
      : "No unusual crowding either direction right now — positioning alone isn't a strong signal here.";

  return (
    <div className="rounded-lg bg-muted/20 border border-border p-3">
      <p className="text-xs leading-relaxed">
        <span className="font-semibold">{selected.displayName}: </span>
        Hedge funds (leveraged money — the fast-moving speculative crowd tracked by the CFTC) are net{" "}
        <span className={cn("font-semibold", net >= 0 ? "text-emerald-400" : "text-red-400")}>
          {direction} {fmtCot(Math.abs(net))} contracts
        </span>
        {pctOfOI != null && <> (~{pctOfOI.toFixed(0)}% of {fmtCot(oi)} total open interest)</>} as of {selected.latest.date}
        {flowVerb && <>, {flowVerb} the position by {fmtCot(Math.abs(chg))} over the past week</>}.{" "}
        That's <span className="font-semibold">{crowding}</span> versus its 1-year range (Z = {z >= 0 ? "+" : ""}{z.toFixed(2)}σ). {implication}
      </p>
    </div>
  );
}

export function CotSection({
  title, summaries, history, selectedInstrument, onSelectInstrument,
}: {
  title: string;
  summaries: COTSummary[];
  history: COTRecord[] | undefined;
  selectedInstrument: string;
  onSelectInstrument: (id: string) => void;
}) {
  const [cotWeeks, setCotWeeks] = useState<12 | 26 | 52>(26);
  const selected = summaries.find((s) => s.instrument === selectedInstrument) ?? summaries[0];
  const historyForSelected = history?.[0]?.instrument === selectedInstrument ? history : undefined;

  const extremes = [...summaries].sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-secondary/20">
        <Activity className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="text-[10px] text-muted-foreground/60 ml-auto">CFTC · weekly</span>
      </div>
      <div className="p-4 space-y-4">

        {/* Instrument selector — continuously scrolling one-row ticker, pauses on hover so chips stay clickable */}
        <div className="rounded-md border border-border overflow-hidden group">
          <div className="flex overflow-hidden">
            <div className="flex animate-marquee group-hover:animate-marquee-paused py-1.5">
              {[...summaries, ...summaries].map((s, i) => {
                const net = s.latest.levMoneyNet;
                const chg = s.latest.levMoneyLongChg - s.latest.levMoneyShortChg;
                const isSelected = s.instrument === selectedInstrument;
                const absZ = Math.abs(s.zScore);
                return (
                  <button
                    key={`${i < summaries.length ? "a" : "b"}-${s.instrument}`}
                    onClick={() => onSelectInstrument(s.instrument)}
                    title="Hedge fund (leveraged money) net position and week-over-week change — click to see full detail below"
                    className={cn(
                      "flex items-center gap-2 text-left rounded-md border px-2.5 py-1 mx-0.5 whitespace-nowrap shrink-0 transition-all",
                      isSelected ? "border-primary/60 bg-primary/10" : "border-border hover:border-border/80 hover:bg-card/80"
                    )}
                  >
                    <span className="text-[11px] font-semibold">{s.displayName}</span>
                    <span className={cn("text-xs font-bold", net >= 0 ? "text-emerald-400" : "text-red-400")}>
                      {net >= 0 ? "+" : ""}{fmtCot(net)}
                    </span>
                    <span className={cn("text-[10px]", chg > 0 ? "text-emerald-400" : chg < 0 ? "text-red-400" : "text-muted-foreground")}>
                      {chg >= 0 ? "+" : ""}{fmtCot(chg)} WoW
                    </span>
                    {absZ >= 1 && (
                      <span className={cn(
                        "text-[9px] px-1 rounded font-semibold shrink-0",
                        absZ > 1.5
                          ? s.zScore > 0 ? "text-emerald-300" : "text-red-300"
                          : "text-yellow-300"
                      )}>
                        {s.zScore > 0 ? "X-LONG" : "X-SHORT"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Selected instrument detail */}
        {selected && (
          <>
          <CotPositioningRead selected={selected} />
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

            {/* History chart */}
            <div className="lg:col-span-2 border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-xs font-semibold">{selected.displayName} — Net Positioning</p>
                  <p className="text-[10px] text-muted-foreground">as of {selected.latest.date}</p>
                </div>
                <div className="flex gap-1">
                  {([12, 26, 52] as const).map((w) => (
                    <button key={w} onClick={() => setCotWeeks(w)}
                      className={cn("text-[10px] px-2 py-1 rounded font-medium transition-colors",
                        cotWeeks === w ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                      {w}W
                    </button>
                  ))}
                </div>
              </div>
              {historyForSelected ? (
                <>
                  <ResponsiveContainer width="100%" height={160}>
                    <LineChart
                      data={historyForSelected.slice(-cotWeeks).map((r) => ({
                        date: r.date.slice(5),
                        "Lev. Money": r.levMoneyNet,
                        "Asset Mgr":  r.assetMgrNet,
                        "Dealer":     r.dealerNet,
                      }))}
                      margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                      <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#cbd5e1" }} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 10, fill: "#cbd5e1" }} tickLine={false} axisLine={false} tickFormatter={fmtCot} width={48} />
                      <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, fontSize: 11 }}
                        formatter={(v: number, name: string) => [fmtCot(v), name]} />
                      <Legend wrapperStyle={{ fontSize: 10, paddingTop: 8 }} />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
                      <Line type="monotone" dataKey="Lev. Money" stroke="#f59e0b" strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="Asset Mgr"  stroke="#60a5fa" strokeWidth={2} dot={false} isAnimationActive={false} />
                      <Line type="monotone" dataKey="Dealer"     stroke="#a78bfa" strokeWidth={1.5} dot={false} strokeDasharray="4 2" isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[10px] text-muted-foreground">
                    <div title="Hedge funds and other leveraged speculators — the fastest-moving, most trend-following positioning"><span className="inline-block w-2 h-0.5 bg-amber-400 mr-1 align-middle" />Lev. Money = hedge funds</div>
                    <div title="Pensions, mutual funds, and other institutional managers — typically slower, more structural positioning"><span className="inline-block w-2 h-0.5 bg-blue-400 mr-1 align-middle" />Asset Mgr = institutions</div>
                    <div title="Banks and market makers hedging client flow — usually the mirror image of speculative positioning"><span className="inline-block w-2 h-0.5 bg-violet-400 mr-1 align-middle" />Dealer = market makers</div>
                  </div>
                </>
              ) : (
                <div className="h-[160px] flex items-center justify-center text-xs text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin mr-2" />Loading history…
                </div>
              )}
            </div>

            {/* Category breakdown + quick stats */}
            <div className="space-y-3">
              {/* Quick stats — the numbers behind the read-out above, for this instrument */}
              <div className="border border-border rounded-lg p-3">
                <p className="text-[11px] text-muted-foreground uppercase tracking-wider mb-2">{selected.displayName} — Raw Figures</p>
                <div className="grid grid-cols-2 gap-3">
                {[
                  { label: "Open Interest", val: fmtCot(selected.latest.openInterest),
                    title: `Total open ${selected.displayName} futures contracts across all trader types — the size of this market. Rising OI alongside a price move confirms new money is driving it; falling OI suggests a move is just positions closing out` },
                  { label: "HF Net",        val: `${selected.latest.levMoneyNet >= 0 ? "+" : ""}${fmtCot(selected.latest.levMoneyNet)}`,
                    title: `Hedge fund (leveraged money) net position in ${selected.displayName} — positive means net long, negative means net short. This is the fast-money crowd, most likely to chase and most likely to reverse` },
                  { label: "HF WoW",        val: `${(selected.latest.levMoneyLongChg - selected.latest.levMoneyShortChg) >= 0 ? "+" : ""}${fmtCot(selected.latest.levMoneyLongChg - selected.latest.levMoneyShortChg)}`,
                    title: "Week-over-week change in hedge fund net positioning — shows whether the fast-money crowd is adding to or trimming its bet right now" },
                  { label: "Z-Score",       val: `${selected.zScore >= 0 ? "+" : ""}${selected.zScore.toFixed(2)}σ`,
                    title: "How extreme current hedge fund positioning is vs. its 1-year range. |Z| > 1.5 = crowded trade, prone to a sharp reversal if it unwinds" },
                ].map(({ label, val, title }) => (
                  <div key={label} title={title}>
                    <div className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</div>
                    <div className="text-sm font-semibold">{val}</div>
                  </div>
                ))}
                </div>
              </div>

              {/* Position breakdown bar chart */}
              <div className="border border-border rounded-lg p-3">
                <p className="text-xs font-semibold mb-0.5">Position Breakdown</p>
                <p className="text-[11px] text-muted-foreground mb-2">Long vs short by category</p>
                <ResponsiveContainer width="100%" height={130}>
                  <BarChart
                    data={[
                      { name: "Lev. Money", Long: selected.latest.levMoneyLong, Short: -selected.latest.levMoneyShort },
                      { name: "Asset Mgr",  Long: selected.latest.assetMgrLong,  Short: -selected.latest.assetMgrShort },
                      { name: "Dealer",     Long: selected.latest.dealerLong,     Short: -selected.latest.dealerShort },
                    ]}
                    layout="vertical" margin={{ top: 0, right: 8, left: 0, bottom: 0 }}
                  >
                    <XAxis type="number" tick={{ fontSize: 9, fill: "#cbd5e1" }} tickLine={false} tickFormatter={(v: number) => fmtCot(Math.abs(v))} />
                    <YAxis type="category" dataKey="name" tick={{ fontSize: 9, fill: "#cbd5e1" }} tickLine={false} axisLine={false} width={68} />
                    <Tooltip contentStyle={{ background: "#1a1a2e", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, fontSize: 11 }}
                      formatter={(v: number) => fmtCot(Math.abs(v))} />
                    <ReferenceLine x={0} stroke="rgba(255,255,255,0.15)" />
                    <Bar dataKey="Long"  fill="#34d399" isAnimationActive={false} radius={[0, 3, 3, 0]} />
                    <Bar dataKey="Short" fill="#f87171" isAnimationActive={false} radius={[0, 3, 3, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
          </>
        )}

        {/* Positioning extremes table */}
        <div className="border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border bg-secondary/10">
            <p className="text-xs font-semibold">Positioning Extremes</p>
            <p className="text-[11px] text-muted-foreground">Ranked by Z-score vs 52-week range · hedge fund (leveraged money) positioning, with institutional and dealer net shown for context</p>
          </div>
          <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-[11px] text-muted-foreground uppercase tracking-wider">
                <th className="text-left px-4 py-2">Instrument</th>
                <th className="text-right px-3 py-2" title="Total open futures contracts — market participation/liquidity">Open Int.</th>
                <th className="text-right px-3 py-2" title="Hedge fund (leveraged money) net position">HF Net</th>
                <th className="text-right px-3 py-2" title="Week-over-week change in hedge fund net positioning">WoW Chg</th>
                <th className="text-right px-3 py-2" title="Institutional (asset manager) net position — typically slower, more structural money">Asset Mgr Net</th>
                <th className="text-right px-3 py-2" title="Dealer/market-maker net position — usually the mirror image of speculative flow">Dealer Net</th>
                <th className="text-right px-4 py-2" title="How extreme hedge fund positioning is vs. its 1-year range. |Z| > 1.5 = crowded trade">Z-Score</th>
              </tr>
            </thead>
            <tbody>
              {extremes.map((s) => {
                const net = s.latest.levMoneyNet;
                const chg = s.latest.levMoneyLongChg - s.latest.levMoneyShortChg;
                return (
                  <tr key={s.instrument} onClick={() => onSelectInstrument(s.instrument)}
                    className="border-b border-border/50 hover:bg-white/5 cursor-pointer transition-colors">
                    <td className="px-4 py-2 font-medium">
                      <div className="flex items-center gap-2">
                        {s.displayName}
                        {Math.abs(s.zScore) >= 1 && (
                          <span className={cn("text-[10px] px-1 py-0.5 rounded border font-semibold",
                            Math.abs(s.zScore) > 1.5
                              ? s.zScore > 0 ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" : "bg-red-500/20 text-red-300 border-red-500/30"
                              : "bg-yellow-500/15 text-yellow-300 border-yellow-500/20")}>
                            {s.zScore > 0 ? "Extreme Long" : "Extreme Short"}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      {fmtCot(s.latest.openInterest)}
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono", net >= 0 ? "text-emerald-400" : "text-red-400")}>
                      {net >= 0 ? "+" : ""}{fmtCot(net)}
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono", chg > 0 ? "text-emerald-400" : chg < 0 ? "text-red-400" : "text-muted-foreground")}>
                      {chg >= 0 ? "+" : ""}{fmtCot(chg)}
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono", s.latest.assetMgrNet >= 0 ? "text-emerald-400" : "text-red-400")}>
                      {s.latest.assetMgrNet >= 0 ? "+" : ""}{fmtCot(s.latest.assetMgrNet)}
                    </td>
                    <td className={cn("px-3 py-2 text-right font-mono", s.latest.dealerNet >= 0 ? "text-emerald-400" : "text-red-400")}>
                      {s.latest.dealerNet >= 0 ? "+" : ""}{fmtCot(s.latest.dealerNet)}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <span className={cn("font-mono font-semibold",
                        Math.abs(s.zScore) > 1.5 ? s.zScore > 0 ? "text-emerald-400" : "text-red-400"
                        : Math.abs(s.zScore) > 1 ? "text-yellow-400" : "text-muted-foreground")}>
                        {s.zScore >= 0 ? "+" : ""}{s.zScore.toFixed(2)}σ
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>

      </div>
    </div>
  );
}
