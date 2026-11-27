/**
 * Rankings › Put ladder (S088, Jamie 10-24: "show every band side by side, the tickers that fit each, default highlighted").
 * One column per |Δ| band: holdout stats (kept, real-fill bp/wk, worst 5 %, safer-half vs riskier-half tail) + today's
 * best listed strike per name in that band (model P(kept), credit %/wk, tail tier, earnings flag).
 * Data: GET /api/options/put-ladder ← watchlist_sync.put_ladder (daily.py S088 step, weekly refit).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { TickerLink } from "@/components/ticker-link";
import { formatMdYy } from "@/lib/format";
import { GRID_HEADER, GRID_TH, GRID_TD } from "@/lib/score-explain-format";
import { SUB_TAB_BAR, guideSubTabClass } from "@/lib/sub-tabs";

type Stats = { n: number; kept: number; p_model: number; bp_hc: number; worst5: number;
  hiP_worst5: number; loP_worst5: number; hiP_kept: number; loP_kept: number;
  hold?: Record<string, { bp_hc: number; worst5: number; n: number }> } | null;
type Pick = { ticker: string; spot: number; strike: number; delta: number; credit: number; creditPctWk: number;
  pKept: number; expPnlBpWk: number; tier: "lower tail" | "higher tail"; zone: boolean; earningsDays: number | null; earningsInWindow: boolean };
type Band = { band: string; stats: Stats; picks: Pick[] };
type Ladder = { asOf: string; default: string; callDefault?: string; statsFrom: string; horizons: Record<string, Band[]>; callHorizons?: Record<string, Band[]> };

const pct = (v: number, dp = 1) => `${(v * 100).toFixed(dp)}%`;
const SHOW = 8;
const bandLabel = (b: string) => `${b.replace("-", "–")}Δ`;

function statTip(s: Stats, engine: boolean) {
  if (!s) return "No history for this distance.";
  const hold = s.hold && Object.keys(s.hold).length
    ? " " + Object.entries(s.hold).map(([w, x]) => `If assigned and held ${w}w: ${x.bp_hc >= 0 ? "+" : ""}${x.bp_hc.toFixed(0)} bp/wk, worst ${x.worst5.toFixed(0)}.`).join(" ")
    : "";
  return `${s.n.toLocaleString()} past trades. Finished kept ${pct(s.kept)}. Model had said ${pct(s.p_model)}. Safer half worst 5%: ${s.hiP_worst5.toFixed(0)} bp. Riskier half: ${s.loP_worst5.toFixed(0)} bp.${hold}${engine ? " This is the distance the engine sells." : ""}`;
}

export function PutLadder() {
  const [h, setH] = useState("1w");
  const [side, setSide] = useState<"put" | "call">("put");
  const [showAll, setShowAll] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["put-ladder"],
    queryFn: async () => {
      const r = await fetch("/api/options/put-ladder");
      if (!r.ok) throw new Error("put ladder failed");
      return (await r.json()) as { ladder: Ladder | null };
    },
    staleTime: 10 * 60_000,
  });
  if (isLoading) return <p className="text-sm text-amber-100 animate-pulse">Loading put ladder…</p>;
  const L = data?.ladder;
  if (!L) return <p className="text-sm text-amber-100">No put ladder yet — built by the weekly S088 run.</p>;
  const H = side === "call" && L.callHorizons ? L.callHorizons : L.horizons;
  const def = side === "call" ? (L.callDefault ?? "") : L.default;
  const bands = H[h] ?? [];
  const open = bands.some((b) => b.band === picked) ? picked! : def;
  const chosen = bands.find((b) => b.band === open) ?? bands[0];
  const picks = chosen ? (showAll ? chosen.picks : chosen.picks.slice(0, SHOW)) : [];
  const week = h.replace("w", " wk");
  return (
    <div className="space-y-1 min-w-0">
      <div className="flex items-center gap-2 flex-wrap">
        {L.callHorizons && (
          <div className={SUB_TAB_BAR}>
            {(["put", "call"] as const).map((k) => (
              <button key={k} type="button" onClick={() => { setSide(k); setPicked(null); setShowAll(false); }} className={guideSubTabClass(side === k)}>
                {k === "put" ? "Sell puts" : "Sell calls"}
              </button>
            ))}
          </div>
        )}
        <div className={SUB_TAB_BAR}>
          {Object.keys(H).map((k) => (
            <button key={k} type="button" onClick={() => setH(k)} className={guideSubTabClass(h === k)}>
              {k.replace("w", " wk")}
            </button>
          ))}
        </div>
        <DataTip tip={`${L.statsFrom}. A band is how far the strike sits from the price (|Δ|). Farther = expires kept more often and pays less per week. Nearer pays more and the bad week is worse. ${side === "put" ? "bp/wk is profit per week of cash set aside, after real fills." : "bp/wk is what the call added versus just holding the shares."} Switch the week to see the same distances at a longer hold.`}>
          <span className="text-[13px] text-white">
            <span className="font-semibold text-[#d4af37]">How far out to sell.</span>
            {" "}Gold row is what the engine sells. Click a row for today’s names.
            {" "}<span className="text-[#d4af37]">{formatMdYy(L.asOf)}</span>
          </span>
        </DataTip>
      </div>

      <div className="flex items-start gap-4">
      <div className="overflow-auto shrink-0">
        <table className="w-auto border-collapse bg-black">
          <thead className="bg-black">
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-left")}>Distance</th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Share of past trades that expired kept (put finished worthless, or the call stayed out of the money).">Kept</DataTip></th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Average profit per week on past trades in this distance, after real fills.">bp/wk</DataTip></th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="The bad case: worst 5% of those trades, in bp.">Worst 5%</DataTip></th>
              <th className={cn(GRID_TH, "text-right")}>Names</th>
            </tr>
          </thead>
          <tbody>
            {bands.map((b, i) => {
              const s = b.stats;
              const engine = b.band === def;
              const on = b.band === open;
              return (
                <tr key={b.band} className={cn("cursor-pointer bg-black border-b border-[#d4af37]/15 hover:bg-white/[0.04]", on && "shadow-[inset_2px_0_0_#fff]")} onClick={() => { setPicked(b.band); setShowAll(false); }}>
                  <td className={cn(GRID_TD, "bg-black text-left font-semibold text-white")}>
                    <DataTip tip={statTip(s, engine)}>{bandLabel(b.band)}{engine ? " · engine" : ""}</DataTip>
                  </td>
                  <td className={cn(GRID_TD, "text-right")}>{s ? pct(s.kept, 0) : "—"}</td>
                  <td className={cn(GRID_TD, "text-right")}>{s ? `${s.bp_hc >= 0 ? "+" : ""}${s.bp_hc.toFixed(0)}` : "—"}</td>
                  <td className={cn(GRID_TD, "text-right", s && s.worst5 < -100 && "text-red-300")}>{s ? s.worst5.toFixed(0) : "—"}</td>
                  <td className={cn(GRID_TD, "text-right")}>{b.picks.length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {chosen && (
        <div className="overflow-auto shrink-0">
          <table className="w-auto border-collapse bg-black">
            <thead className="bg-black">
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "text-left")}>
                  {bandLabel(chosen.band)} · {week}
                  {chosen.picks.length > SHOW && (
                    <button type="button" onClick={() => setShowAll((v) => !v)} className="ml-2 normal-case tracking-normal text-[#d4af37]">
                      {showAll ? `top ${SHOW}` : `all ${chosen.picks.length}`}
                    </button>
                  )}
                </th>
                <th className={cn(GRID_TH, "text-right")}>Strike</th>
                <th className={cn(GRID_TH, "text-right")}><DataTip tip="Credit collected per week, as a percent of the strike.">Credit/wk</DataTip></th>
                <th className={cn(GRID_TH, "text-right")}><DataTip tip="Model chance this strike finishes kept. Green dot = safer half of this distance. Gold dot = riskier half. E = earnings before expiry.">P(kept)</DataTip></th>
              </tr>
            </thead>
            <tbody>
              {picks.map((p, i) => (
                <tr key={p.ticker} className="bg-black border-b border-[#d4af37]/15">
                  <td className={cn(GRID_TD, "text-left")}>
                    <span className="inline-flex items-center">
                      <span className={cn("inline-block w-1.5 h-1.5 rounded-full mr-1", p.tier === "lower tail" ? "bg-emerald-400" : "bg-amber-400")} />
                      <TickerLink ticker={p.ticker} />
                      {p.earningsInWindow && <DataTip tip={`Earnings in ${p.earningsDays} days — inside this expiry`}><span className="ml-0.5 text-red-300">E</span></DataTip>}
                    </span>
                  </td>
                  <td className={cn(GRID_TD, "text-right")}>
                    <DataTip tip={`Spot ${p.spot} · ${p.delta.toFixed(2)}Δ · credit $${p.credit.toFixed(2)}${p.zone ? " · at a support zone" : ""} · model ${p.expPnlBpWk >= 0 ? "+" : ""}${p.expPnlBpWk} bp/wk`}>
                      <span>{p.strike}</span>
                    </DataTip>
                  </td>
                  <td className={cn(GRID_TD, "text-right")}>{p.creditPctWk.toFixed(2)}%</td>
                  <td className={cn(GRID_TD, "text-right")}>{pct(p.pKept, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      </div>
    </div>
  );
}
