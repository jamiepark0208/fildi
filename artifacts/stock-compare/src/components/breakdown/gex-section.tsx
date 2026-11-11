/**
 * Breakdown › Dealer gamma (north-star #7) — GEX by strike from the live Schwab chain (≤ 60 DTE, OI = prior close).
 * GET /api/stocks/:t/gex. Convention: dealers long calls / short puts (gex-tracker, A311). Display only, untested edge.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";

type Row = { strike: number; callGex: number; putGex: number; netGex: number };
type Summary = {
  spot: number; netGex: number; callGex: number; putGex: number;
  gammaFlip: number | null; callWall: number | null; putWall: number | null; nContracts: number;
};
type Profile = { ticker: string; asOf: string; maxDte: number; summary: Summary; strikes: Row[]; fetchedAt: string };

export const GEX_TIP =
  "Dealer gamma exposure: Σ gamma × OI × 100 × spot² × 1 %, i.e. $ of stock dealers trade per 1 % move. Assumes dealers are long calls and short puts (the common convention; real positioning is unknown). Positive net = dealers sell rallies / buy dips → moves damped. Negative = they chase → moves amplified. Flip = spot where net GEX crosses zero. Put wall = strike with the most put gamma (often support); call wall = most call gamma (often a cap). Live Schwab chain, ≤ 60 DTE, OI from the prior close. Untested as an edge here — context only.";

const money = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(0)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(0)}k` : a.toFixed(0);
  return `${v < 0 ? "−" : ""}$${s}`;
};
/** Strikes keep their half/quarter steps (162.5 must not print as 163); spot rounds to cents. */
const px = (v: number | null) => (v == null ? "—" : String(Number(v.toFixed(2))));
const pct = (v: number | null, spot: number) => (v == null || !(spot > 0) ? "" : ` (${v >= spot ? "+" : "−"}${(Math.abs(v / spot - 1) * 100).toFixed(1)}%)`);

function useGex(ticker: string) {
  return useQuery({
    queryKey: ["gex", ticker],
    queryFn: async (): Promise<Profile | null> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/gex`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).profile ?? null;
    },
    staleTime: 15 * 60_000,
  });
}

/** Strikes within ±10 % of spot; if more than 41, keep the 41 with the largest gross gamma (always keeps walls). */
function visibleRows(p: Profile): Row[] {
  const spot = p.summary.spot;
  const near = p.strikes.filter((r) => Math.abs(r.strike / spot - 1) <= 0.1);
  if (near.length <= 41) return near;
  const keep = new Set(
    [...near].sort((a, b) => Math.abs(b.callGex) + Math.abs(b.putGex) - (Math.abs(a.callGex) + Math.abs(a.putGex))).slice(0, 41).map((r) => r.strike),
  );
  return near.filter((r) => keep.has(r.strike));
}

export function GexHeaderStats({ ticker }: { ticker: string }) {
  const { data } = useGex(ticker);
  const s = data?.summary;
  return (
    <div className="flex items-center gap-2">
      {s && (
        <span className={cn("text-[10px]", s.netGex >= 0 ? "text-green-400" : "text-red-400")}>
          net {money(s.netGex)} · {s.netGex >= 0 ? "damped" : "amplified"}
        </span>
      )}
      <DataTip tip={GEX_TIP}>
        <span className="rounded border border-amber-400/40 px-1 text-[9px] uppercase tracking-wide text-amber-300">assumed side · untested</span>
      </DataTip>
    </div>
  );
}

export function GexSection({ ticker }: { ticker: string }) {
  const { data, isLoading } = useGex(ticker);
  if (isLoading) return <p className="text-[10px] text-amber-100">Loading dealer gamma…</p>;
  if (!data) return <p className="text-[10px] text-amber-100">No option chain for {ticker} (Schwab unavailable or no open interest ≤ 60 DTE).</p>;
  const s = data.summary;
  const rows = visibleRows(data);
  const max = Math.max(1, ...rows.map((r) => Math.max(Math.abs(r.callGex), Math.abs(r.putGex))));
  // Spot sits between the last strike ≤ spot and the next one; draw the marker above the first strike > spot (rows render high → low).
  const desc = [...rows].reverse();
  const spotIdx = desc.findIndex((r) => r.strike <= s.spot);
  return (
    <div className="space-y-1">
      <p className="text-[10px] leading-snug text-white">
        Spot {px(s.spot)} · flip {px(s.gammaFlip)}{pct(s.gammaFlip, s.spot)}
        {s.gammaFlip != null && <span className="text-amber-100">{s.spot >= s.gammaFlip ? " — above flip, dealers damp moves" : " — below flip, dealers amplify moves"}</span>}
        {" · "}
        <span className="text-red-400">put wall {px(s.putWall)}{pct(s.putWall, s.spot)}</span> ·{" "}
        <span className="text-green-400">call wall {px(s.callWall)}{pct(s.callWall, s.spot)}</span>
      </p>
      <div className="text-[9px] text-amber-100">
        Per 1 % move · calls {money(s.callGex)} / puts {money(s.putGex)} · {s.nContracts.toLocaleString()} contracts ≤ {data.maxDte} DTE · strikes ±10 %
      </div>
      <div className="font-mono text-[10px]">
        {desc.map((r, i) => {
          const wall = r.strike === s.putWall ? "put wall" : r.strike === s.callWall ? "call wall" : null;
          return (
            <div key={r.strike}>
              {i === spotIdx && (
                <div className="my-0.5 flex items-center gap-1 text-[9px] text-[#d4af37]">
                  <span className="h-px flex-1 bg-[#d4af37]/60" />spot {px(s.spot)}<span className="h-px flex-1 bg-[#d4af37]/60" />
                </div>
              )}
              <div className={cn("grid grid-cols-[52px_1fr_1fr_64px] items-center gap-1", wall && "bg-white/5")}>
                <span className={cn("text-right", wall ? "text-[#d4af37] font-semibold" : "text-white")}>{px(r.strike)}</span>
                <div className="flex h-2.5 justify-end">
                  <div className="h-full rounded-l bg-red-500/70" style={{ width: `${(Math.abs(r.putGex) / max) * 100}%` }} />
                </div>
                <div className="flex h-2.5">
                  <div className="h-full rounded-r bg-green-500/70" style={{ width: `${(Math.abs(r.callGex) / max) * 100}%` }} />
                </div>
                <span className={cn("text-right", r.netGex >= 0 ? "text-green-400" : "text-red-400")}>{money(r.netGex)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
