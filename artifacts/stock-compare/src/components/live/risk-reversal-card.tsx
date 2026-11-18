// Jamie 11-18: "sell OTM puts for income, use it to buy long OTM calls" — put-funded calls (risk reversal). One pair per
// name: short put at/below support (25–65 DTE), long call between spot and the first resistance ≥ +10 % (85–190 DTE).
// Data: GET /api/today/risk-reversals (lib/risk-reversal.ts). Ordered by quality (Model List `own`), held names marked.
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { GRID_WRAP, GRID_HEADER, GRID_TH } from "@/lib/score-explain-format";

type Leg = { expiry: string; dte: number; strike: number; bid: number; ask: number; fill: number; iv: number; delta: number };
type Level = { price: number; kind: string };
type Row = {
  ticker: string; held: boolean; own: number | null; offHigh: number | null; spot: number;
  put: Leg; call: Leg; net: number; support: Level | null; resistance: Level | null;
  putSkew: number | null; callSkew: number | null; rr25Put: number | null; rr25Call: number | null; term: number | null;
  volEdge: number; putOverCall: number; rollsToFund: number; rollsAvailable: number; pPutSafe: number; pCallItm: number; pCallBe: number;
  earnings: string | null; earningsInPut: boolean;
  cashIfAssigned: number; assignedBasis: number; callMoveToStrike: number;
};

const TH = cn(GRID_TH, "px-1.5 py-0.5");
const TD = "px-1.5 py-0.5 text-[13px] text-white";
const pc = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)} %`);
const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(Math.round(x)).toLocaleString()}`;

const TIP = "Sell 1 put (14–45 days: the expiry that sells the most IV at support), buy 1 call (85–190 days) below the first resistance ≥ +10 %. "
  + "Skew is per expiry: Skew front = 25Δ put IV − 25Δ call IV on the put's expiry; Skew back = same on the call's expiry. "
  + "Vol edge = IV you sell − IV you buy (front skew + inverted term together). Term = back ATM IV ÷ front ATM IV (< 1 = back month cheap). "
  + "Rolls = call cost ÷ one put credit, vs put cycles that fit before the call expires — future credits are not guaranteed (IV falls after a panic). "
  + "Fills = bid/ask ± 23 % of the spread (typical RH fill). Odds use each option's own IV, no drift — not a forecast. "
  + "History (S178, 15 panic weeks, matched 30-day legs only): 0.25Δ put + 0.50Δ call +6 % per $ of strike vs +2.3 % put alone; "
  + "losing weeks were early in a panic — tested entry is after the fear curve un-inverts. Mismatched expiries are untested. "
  + "ER = earnings before the put expires: its high IV is the report (gap risk), not skew. "
  + "If assigned you own 100 shares at the strike; FILDI has a margin loan → no new puts there (10-06 rule).";

export function RiskReversalCard() {
  const { data, isLoading } = useQuery<{ rows: Row[]; skipped: { ticker: string; why: string }[]; asOf: string }>({
    queryKey: ["today-risk-reversals"],
    queryFn: async () => {
      const r = await fetch("/api/today/risk-reversals", { credentials: "include" });
      if (!r.ok) throw new Error(`risk-reversals ${r.status}`);
      return r.json();
    },
    staleTime: 15 * 60_000,
  });
  if (isLoading) return <div className="text-[12px] text-amber-100 px-2 py-1">Put-funded calls: pricing live chains (~30 s first load)…</div>;
  if (!data?.rows.length) return null;
  const rows = [...data.rows].sort((a, b) => (b.own ?? 0) - (a.own ?? 0));
  return (
    <div className={GRID_WRAP} data-testid="today-risk-reversals">
      <div className={cn(GRID_HEADER, "px-2 py-1")}>
        <DataTip tip={TIP}>
          <span className="text-[13px] font-semibold uppercase tracking-wide text-white">
            Put-funded calls · sell put at support, buy call to resistance · {rows.length} names
          </span>
        </DataTip>
      </div>
      <table className="w-full">
        <thead><tr>
          {["Ticker", "Quality", "Off high", "Spot", "Sell put", "Credit", "Put safe", "Buy call", "Cost", "Net /pair", "Call ends ITM", "Skew front · back", "Vol edge", "Term", "Rolls to fund", "Cash if assigned"]
            .map((h) => <th key={h} className={TH}>{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.ticker} className="border-t border-white/5"
              title={`Support ${r.support ? `${r.support.price.toFixed(2)} (${r.support.kind})` : "none"} · target ${r.resistance ? `${r.resistance.price.toFixed(2)} (${r.resistance.kind})` : "+30 %"}. `
                + `Put ${r.put.strike} Δ${r.put.delta.toFixed(2)} IV ${pc(r.put.iv)} (bid ${r.put.bid} / ask ${r.put.ask}); call ${r.call.strike} Δ${r.call.delta.toFixed(2)} IV ${pc(r.call.iv)} (bid ${r.call.bid} / ask ${r.call.ask}). `
                + `Assigned basis ${r.assignedBasis.toFixed(2)}. Call needs +${(r.callMoveToStrike * 100).toFixed(0)} % to reach its strike; ends above strike + net debit ${pc(r.pCallBe)}.`}>
              <td className={cn(TD, "text-left font-semibold")}>{r.ticker}{r.held && <span className="ml-1 text-amber-300 text-[11px]">held</span>}</td>
              <td className={TD}>{r.own == null ? "—" : Math.round(r.own)}</td>
              <td className={TD}>{r.offHigh == null ? "—" : `${Math.round(r.offHigh * 100)} %`}</td>
              <td className={TD}>{r.spot.toFixed(2)}</td>
              <td className={TD}>{r.put.strike}P {r.put.expiry.slice(5)}{r.earningsInPut && <span className="ml-1 text-red-400 text-[11px]" title="Earnings before the put expires — the high front IV is the report, not skew (gap risk)">ER {r.earnings!.slice(5)}</span>}</td>
              <td className={cn(TD, "text-green-300")}>{usd(r.put.fill * 100)}</td>
              <td className={TD}>{pc(r.pPutSafe)}</td>
              <td className={TD}>{r.call.strike}C {r.call.expiry.slice(5)}</td>
              <td className={cn(TD, "text-red-300/80")}>{usd(r.call.fill * 100)}</td>
              <td className={cn(TD, "font-semibold", r.net >= -0.1 * r.put.fill ? "text-green-400" : r.net >= -r.put.fill ? "text-amber-300" : "text-red-400")}>{usd(r.net * 100)}</td>
              <td className={TD}>{pc(r.pCallItm)}</td>
              <td className={TD}>{r.rr25Put == null ? "—" : (r.rr25Put * 100).toFixed(1)} · {r.rr25Call == null ? "—" : (r.rr25Call * 100).toFixed(1)}</td>
              <td className={cn(TD, r.volEdge >= 0.08 ? "text-green-400" : r.volEdge >= 0.03 ? "text-amber-300" : "text-red-400")}>{(r.volEdge * 100).toFixed(1)} pts</td>
              <td className={TD}>{r.term == null ? "—" : r.term.toFixed(2)}</td>
              <td className={cn(TD, r.rollsToFund <= Math.min(2, r.rollsAvailable) ? "text-green-400" : "text-amber-300")}>{r.rollsToFund.toFixed(1)} of {r.rollsAvailable}</td>
              <td className={TD}>{usd(r.cashIfAssigned)}</td>
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
