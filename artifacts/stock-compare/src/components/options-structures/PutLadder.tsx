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

type Stats = { n: number; kept: number; p_model: number; bp_hc: number; worst5: number;
  hiP_worst5: number; loP_worst5: number; hiP_kept: number; loP_kept: number;
  hold?: Record<string, { bp_hc: number; worst5: number; n: number }> } | null;
type Pick = { ticker: string; spot: number; strike: number; delta: number; credit: number; creditPctWk: number;
  pKept: number; expPnlBpWk: number; tier: "lower tail" | "higher tail"; zone: boolean; earningsDays: number | null; earningsInWindow: boolean };
type Band = { band: string; stats: Stats; picks: Pick[] };
type Ladder = { asOf: string; default: string; callDefault?: string; statsFrom: string; horizons: Record<string, Band[]>; callHorizons?: Record<string, Band[]> };

const pct = (v: number, dp = 1) => `${(v * 100).toFixed(dp)}%`;
const SHOW = 15;

function BandColumn({ b, isDefault, showAll }: { b: Band; isDefault: boolean; showAll: boolean }) {
  const s = b.stats;
  const picks = showAll ? b.picks : b.picks.slice(0, SHOW);
  return (
    <div className={cn("rounded border p-1.5 min-w-[190px] flex-1",
      isDefault ? "border-[#d4af37] bg-[#d4af37]/5" : "border-zinc-800 bg-zinc-950")}>
      <div className="flex items-baseline justify-between">
        <span className={cn("text-[12px] font-semibold", isDefault ? "text-[#d4af37]" : "text-zinc-200")}>
          {b.band.replace("-", "–")}Δ
        </span>
        {isDefault && <span className="text-[10px] text-[#d4af37]">default</span>}
      </div>
      {s ? (
        <DataTip tip={`Holdout 2023 →, ${s.n.toLocaleString()} sold puts. Model said ${pct(s.p_model)} kept. Safer half (higher model P) worst 5 %: ${s.hiP_worst5.toFixed(0)} bp vs riskier half ${s.loP_worst5.toFixed(0)} bp.`}>
          <div className="text-[10px] text-amber-100 leading-tight mt-0.5 cursor-help">
            kept <span className="text-zinc-200">{pct(s.kept)}</span> · <span className="text-zinc-200">{s.bp_hc >= 0 ? "+" : ""}{s.bp_hc.toFixed(0)}</span> bp/wk
            <br />worst 5 % <span className={s.worst5 < -100 ? "text-red-300" : "text-zinc-200"}>{s.worst5.toFixed(0)}</span> bp
          </div>
        </DataTip>
      ) : <div className="text-[10px] text-amber-100/80 mt-0.5">no holdout stats</div>}
      {s?.hold && Object.keys(s.hold).length > 0 && (
        <DataTip tip={"If assigned, keep the shares N more weeks and mark them then (recovery counted, further drops too). bp per collateral-week incl. the holding weeks; worst 5 % per trade-week."}>
          <div className="text-[10px] text-amber-100/80 leading-tight cursor-help">
            {Object.entries(s.hold).map(([n, x]) => (
              <div key={n}>hold {n}w: <span className="text-zinc-300">{x.bp_hc >= 0 ? "+" : ""}{x.bp_hc.toFixed(0)}</span> · {x.worst5.toFixed(0)}</div>
            ))}
          </div>
        </DataTip>
      )}
      <div className="text-[10px] text-amber-100/80 mt-1 mb-0.5">{b.picks.length} names today</div>
      <table className="w-full text-[11px]">
        <tbody>
          {picks.map((p) => (
            <tr key={p.ticker} className="border-t border-zinc-900">
              <td className="py-0.5">
                <span className={cn("inline-block w-1.5 h-1.5 rounded-full mr-1", p.tier === "lower tail" ? "bg-emerald-400" : "bg-amber-400")} />
                <TickerLink ticker={p.ticker} />
                {p.earningsInWindow && <DataTip tip={`Earnings in ${p.earningsDays} days — inside this expiry`}><span className="ml-0.5 text-red-300">E</span></DataTip>}
              </td>
              <td className="text-right text-zinc-300">
                <DataTip tip={`Spot ${p.spot} · strike ${p.strike} · ${p.delta.toFixed(2)}Δ · credit $${p.credit.toFixed(2)}${p.zone ? " · at a support zone" : ""} · model expected ${p.expPnlBpWk >= 0 ? "+" : ""}${p.expPnlBpWk} bp/wk`}>
                  <span className="cursor-help">{p.strike}</span>
                </DataTip>
              </td>
              <td className="text-right text-zinc-300">{p.creditPctWk.toFixed(2)}%</td>
              <td className="text-right text-amber-100">{pct(p.pKept, 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** DTE side by side (Jamie 10-24: no single cutoff): real-fill bp/wk and worst 5 % per band for every horizon. */
function HorizonStrip({ H, def }: { H: Record<string, Band[]>; def: string }) {
  const hs = Object.keys(H);
  const bands = H[hs[0]]?.map((b) => b.band) ?? [];
  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] text-amber-100">
        <thead>
          <tr>
            <th className="text-left pr-2 font-normal">bp/wk · worst 5 %</th>
            {bands.map((b) => <th key={b} className={cn("px-1.5 font-normal", b === def && "text-[#d4af37]")}>{b.replace("-", "–")}Δ</th>)}
          </tr>
        </thead>
        <tbody>
          {hs.map((h) => (
            <tr key={h}>
              <td className="pr-2 text-zinc-300">{h.replace("w", " wk")}</td>
              {H[h].map((b) => (
                <td key={b.band} className={cn("px-1.5 tabular-nums", b.band === def && "text-[#d4af37]")}>
                  {b.stats ? <>{b.stats.bp_hc >= 0 ? "+" : ""}{b.stats.bp_hc.toFixed(0)} · <span className={b.stats.worst5 < -100 ? "text-red-300" : ""}>{b.stats.worst5.toFixed(0)}</span></> : "—"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PutLadder() {
  const [h, setH] = useState("1w");
  const [side, setSide] = useState<"put" | "call">("put");
  const [showAll, setShowAll] = useState(false);
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
  return (
    <div className="space-y-2 min-w-0">
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        {L.callHorizons && (
          <div className="flex items-center rounded-full border border-[#d4af37]/25 bg-zinc-950 p-0.5 h-6">
            {(["put", "call"] as const).map((k) => (
              <button key={k} onClick={() => setSide(k)}
                className={cn("px-2 h-5 rounded-full font-semibold", side === k ? "bg-[#d4af37]/25 text-[#d4af37]" : "text-amber-200/50 hover:text-[#d4af37]")}>
                {k === "put" ? "Sell puts" : "Sell calls"}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-center rounded-full border border-[#d4af37]/25 bg-zinc-950 p-0.5 h-6">
          {Object.keys(H).map((k) => (
            <button key={k} onClick={() => setH(k)}
              className={cn("px-2 h-5 rounded-full font-semibold", h === k ? "bg-[#d4af37]/25 text-[#d4af37]" : "text-amber-200/50 hover:text-[#d4af37]")}>
              {k.replace("w", " wk")}
            </button>
          ))}
        </div>
        <button onClick={() => setShowAll((v) => !v)} className="text-amber-200/60 hover:text-[#d4af37]">
          {showAll ? `top ${SHOW} per band` : "show every name"}
        </button>
        <span className="text-amber-100/80">
          as of {formatMdYy(L.asOf)} · columns = |Δ| bands · per name: strike · credit %/wk · model P(kept) ·
          <span className="text-emerald-400"> ●</span> safer half <span className="text-amber-400">●</span> riskier half of its band · E = earnings before expiry
        </span>
      </div>
      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {bands.map((b) => <BandColumn key={b.band} b={b} isDefault={b.band === def} showAll={showAll} />)}
      </div>
      <HorizonStrip H={H} def={def} />
      <p className="text-[10px] text-amber-100/80">
        Stats: {L.statsFrom}. {side === "put"
          ? "Puts: bp per week of collateral after real fills. Farther bands keep more often at similar weekly pay; nearer bands carry a bigger worst 5 %."
          : "Covered calls: bp per week per $ of stock vs just holding it (negative = the call cost you upside). Kept = stock stayed below the strike."}{" "}
        The model's P(kept) mainly sorts tail risk inside a band.
      </p>
    </div>
  );
}
