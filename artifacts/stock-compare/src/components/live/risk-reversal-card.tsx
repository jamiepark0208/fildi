// Jamie 11-18: "sell OTM puts for income, use it to buy long OTM calls" — and the same framework for the bearish mirror.
// Bull: short put at/below support (14–45 DTE) + long call toward the first resistance ≥ +10 % (85–190 DTE).
// Bear: short call at/above resistance + long put toward the first support ≥ −10 %. Both always listed; the regime only
// picks which tab opens. Data: GET /api/today/risk-reversals (lib/risk-reversal.ts). Sorted by vol edge, ER rows last.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { GRID_WRAP, GRID_HEADER, GRID_TH } from "@/lib/score-explain-format";

type Leg = { side: "put" | "call"; expiry: string; dte: number; strike: number; bid: number; ask: number; fill: number; iv: number; delta: number };
type Level = { price: number; kind: string };
type Row = {
  ticker: string; held: boolean; own: number | null; offHigh: number | null; spot: number; direction: "bull" | "bear";
  short: Leg; long: Leg; net: number; anchor: Level | null; target: Level | null;
  rr25Short: number | null; rr25Long: number | null; term: number | null;
  volEdge: number; rollsToFund: number; rollsAvailable: number; pShortSafe: number; pLongItm: number; pLongBe: number;
  cashIfAssigned: number | null; longMoveToStrike: number; earnings: string | null; earningsInShort: boolean;
  skewRank?: SkewRank | null;
};
type SkewRank = { rr25: number; asOf: string; dte: number; ownPct: number | null; ownN: number; ownMedian: number | null;
  sector: string | null; sectorPct: number | null; sectorN: number; sectorMedian: number | null; universePct: number | null };
type Resp = { rows: Row[]; skipped: { ticker: string; why: string }[]; asOf: string;
  regime?: { fear: number | null; medianOffHigh: number | null; defaultDirection: "bull" | "bear" } };

const TH = cn(GRID_TH, "px-1.5 py-0.5");
const TD = "px-1.5 py-0.5 text-[13px] text-white";
const pc = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)} %`);
const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(Math.round(x)).toLocaleString()}`;
const leg = (l: Leg) => `${l.strike}${l.side === "put" ? "P" : "C"} ${l.expiry.slice(5)}`;
const vp = (x: number | null) => (x == null ? "—" : (x * 100).toFixed(1));
const pct = (x: number | null) => (x == null ? "—" : String(Math.round(x * 100)));
// Rich side for the trade: bull sells puts → high put-skew rank good; bear sells calls → low rank (calls rich) good
const rankGood = (x: number | null, dir: "bull" | "bear") => x != null && (dir === "bull" ? x >= 0.8 : x <= 0.2);
const rankTip = (k: SkewRank) => `Front-month (${k.dte} d, ${k.asOf.slice(5)}) 25Δ put − call IV ${vp(k.rr25)} pts. `
  + `Own: ${pct(k.ownPct)}th pct of its last ${k.ownN} days (median ${vp(k.ownMedian)}). `
  + `${k.sector ?? "No sector"}: ${pct(k.sectorPct)}th of ${k.sectorN} names (median ${vp(k.sectorMedian)}). All names: ${pct(k.universePct)}th. `
  + "Needs ≥ 10 days / ≥ 5 peers, else —. History starts 10-08 (Schwab chain store, mostly weeklies). Tested 11-18 (S185c, 59 names, 13 months): can't answer yet "
  + "(≤ 6 independent weeks per regime) → no proven edge; don't pick a trade on this rank alone.";

const TIP = "Bull = sell a put at support, buy a longer call toward resistance. Bear = sell a call at resistance, buy a longer put toward support. "
  + "Short leg 14–45 days (the expiry that sells the most IV), long leg 85–190 days. Fills = bid/ask ± 23 % of the spread. "
  + "Skew short · long = 25Δ put IV − 25Δ call IV on each leg's own expiry (+ puts rich, − calls rich). "
  + "Vol edge = IV sold − IV bought. Term = long ATM IV ÷ short ATM IV (< 1 = back month cheap). "
  + "Rolls = long cost ÷ one short credit vs cycles that fit — future credits not guaranteed. ER = earnings before the short leg expires (event IV, not skew). "
  + "Skew rank own · sector = today's front-month 25Δ skew as a percentile of the name's own last 60 days and of its sector today "
  + "(bull wants high = puts rich, bear wants low = calls rich). "
  + "Odds use each option's IV, no drift. History: same-expiry 30-day bull RR +6 %/$ strike vs +2.3 % put alone, 15 panic weeks (S178); "
  + "mismatched expiries and the bear side are untested. Bull short put = cash-secured (FILDI margin loan → no new puts). "
  + "Bear short call = uncapped unless you own 100 shares (then covered call + bought put = a funded collar).";

export function RiskReversalCard() {
  const { data, isLoading } = useQuery<Resp>({
    queryKey: ["today-risk-reversals"],
    queryFn: async () => {
      const r = await fetch("/api/today/risk-reversals", { credentials: "include" });
      if (!r.ok) throw new Error(`risk-reversals ${r.status}`);
      return r.json();
    },
    staleTime: 15 * 60_000,
  });
  const [pick, setPick] = useState<"bull" | "bear" | null>(null);
  if (isLoading) return <div className="text-[12px] text-amber-100 px-2 py-1">Risk reversals: pricing live chains…</div>;
  if (!data?.rows.length) return null;
  const dir = pick ?? data.regime?.defaultDirection ?? "bull";
  const rows = data.rows.filter((r) => r.direction === dir)
    .sort((a, b) => (Number(a.earningsInShort) - Number(b.earningsInShort)) || (b.volEdge - a.volEdge));
  const rg = data.regime;
  return (
    <div className={GRID_WRAP} data-testid="today-risk-reversals">
      <div className={cn(GRID_HEADER, "px-2 py-1 flex items-center gap-3")}>
        <DataTip tip={TIP}>
          <span className="text-[13px] font-semibold uppercase tracking-wide text-white">
            Risk reversals · {dir === "bull" ? "sell put at support → buy call" : "sell call at resistance → buy put"} · {rows.length} names
          </span>
        </DataTip>
        {(["bull", "bear"] as const).map((d) => (
          <button key={d} type="button" onClick={() => setPick(d)}
            className={cn("text-[12px] px-2 py-0.5 rounded border", d === dir ? "border-amber-300 text-amber-300" : "border-white/20 text-white")}>
            {d === "bull" ? "Bullish" : "Bearish"}{rg?.defaultDirection === d ? " (regime)" : ""}
          </button>
        ))}
        {rg?.fear != null && <span className="text-[12px] text-amber-100">fear curve {rg.fear.toFixed(2)}{rg.medianOffHigh != null ? ` · median name ${Math.round(rg.medianOffHigh * 100)} % off high` : ""}</span>}
      </div>
      <table className="w-full">
        <thead><tr>
          {["Ticker", "Quality", "Off high", "Spot", "Sell", "Credit", "Short safe", "Buy", "Cost", "Net /pair", "Long ITM", "Skew short · long", "Skew rank own · sector", "Vol edge", "Term", "Rolls to fund", "Cash if assigned"]
            .map((h) => <th key={h} className={TH}>{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.ticker}-${r.direction}`} className="border-t border-white/5"
              title={`${r.direction === "bull" ? "Support" : "Resistance"} ${r.anchor ? `${r.anchor.price.toFixed(2)} (${r.anchor.kind})` : "none"} · target ${r.target ? `${r.target.price.toFixed(2)} (${r.target.kind})` : "±30 %"}. `
                + `Short ${leg(r.short)} Δ${r.short.delta.toFixed(2)} IV ${pc(r.short.iv)} (${r.short.bid}/${r.short.ask}); long ${leg(r.long)} Δ${r.long.delta.toFixed(2)} IV ${pc(r.long.iv)} (${r.long.bid}/${r.long.ask}). `
                + `Long needs ${(r.longMoveToStrike * 100).toFixed(0)} % to its strike; past strike + net debit ${pc(r.pLongBe)}.`}>
              <td className={cn(TD, "text-left font-semibold")}>{r.ticker}{r.held && <span className="ml-1 text-amber-300 text-[11px]">held</span>}</td>
              <td className={TD}>{r.own == null ? "—" : Math.round(r.own)}</td>
              <td className={TD}>{r.offHigh == null ? "—" : `${Math.round(r.offHigh * 100)} %`}</td>
              <td className={TD}>{r.spot.toFixed(2)}</td>
              <td className={TD}>{leg(r.short)}{r.earningsInShort && <span className="ml-1 text-red-400 text-[11px]" title="Earnings before the short leg expires — its high IV is the report (gap risk), not skew">ER {r.earnings!.slice(5)}</span>}</td>
              <td className={cn(TD, "text-green-300")}>{usd(r.short.fill * 100)}</td>
              <td className={TD}>{pc(r.pShortSafe)}</td>
              <td className={TD}>{leg(r.long)}</td>
              <td className={cn(TD, "text-red-300/80")}>{usd(r.long.fill * 100)}</td>
              <td className={cn(TD, "font-semibold", r.net >= -0.1 * r.short.fill ? "text-green-400" : "text-amber-300")}>{usd(r.net * 100)}</td>
              <td className={TD}>{pc(r.pLongItm)}</td>
              <td className={TD}>{vp(r.rr25Short)} · {vp(r.rr25Long)}</td>
              <td className={TD} title={r.skewRank ? rankTip(r.skewRank) : "No front-month skew history for this name"}>
                {r.skewRank ? <>
                  <span className={rankGood(r.skewRank.ownPct, r.direction) ? "text-green-400" : undefined}>{pct(r.skewRank.ownPct)}</span>
                  {" · "}
                  <span className={rankGood(r.skewRank.sectorPct, r.direction) ? "text-green-400" : undefined}>{pct(r.skewRank.sectorPct)}</span>
                </> : "—"}
              </td>
              <td className={cn(TD, r.volEdge >= 0.08 ? "text-green-400" : r.volEdge >= 0.03 ? "text-amber-300" : "text-red-400")}>{vp(r.volEdge)} pts</td>
              <td className={TD}>{r.term == null ? "—" : r.term.toFixed(2)}</td>
              <td className={cn(TD, r.rollsToFund <= Math.min(2, r.rollsAvailable) ? "text-green-400" : "text-amber-300")}>{r.rollsToFund.toFixed(1)} of {r.rollsAvailable}</td>
              <td className={TD}>{r.cashIfAssigned != null ? usd(r.cashIfAssigned) : r.held ? "covered?" : "uncapped"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.skipped.length > 0 && (
        <div className="px-2 py-1 text-[11px] text-amber-100">Not priced: {data.skipped.map((s) => s.ticker).join(", ")} (no live chain or no strike in the bands)</div>
      )}
    </div>
  );
}
