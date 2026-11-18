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
  putSkew: number | null; putOverCall: number; pPutSafe: number; pCallItm: number; pCallBe: number;
  cashIfAssigned: number; assignedBasis: number; callMoveToStrike: number;
};

const TH = cn(GRID_TH, "px-1.5 py-0.5");
const TD = "px-1.5 py-0.5 text-[13px] text-white";
const pc = (x: number | null | undefined) => (x == null ? "—" : `${Math.round(x * 100)} %`);
const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(Math.round(x)).toLocaleString()}`;

const TIP = "Sell 1 put, buy 1 call. Put strike = at or below the nearest support; call strike = below the first resistance ≥ +10 %. "
  + "Fills = bid/ask ± 23 % of the spread (typical RH fill). Odds use each option's own IV, no drift — not a forecast. "
  + "History (S178, 15 panic weeks): 0.25Δ put + 0.50Δ call made +6 % per $ of strike vs +2.3 % for the put alone; "
  + "the losing weeks were early in a panic — the tested entry is after the fear curve un-inverts. Single-name puts are "
  + "only ~5–20 % richer than calls, so one put rarely pays for a far-OTM call: a small debit is normal. "
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
          {["Ticker", "Quality", "Off high", "Spot", "Sell put", "Credit", "Put safe", "Buy call", "Cost", "Net /pair", "Call ends ITM", "Put ÷ call IV", "Cash if assigned"]
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
              <td className={TD}>{r.put.strike}P {r.put.expiry.slice(5)}</td>
              <td className={cn(TD, "text-green-300")}>{usd(r.put.fill * 100)}</td>
              <td className={TD}>{pc(r.pPutSafe)}</td>
              <td className={TD}>{r.call.strike}C {r.call.expiry.slice(5)}</td>
              <td className={cn(TD, "text-red-300/80")}>{usd(r.call.fill * 100)}</td>
              <td className={cn(TD, "font-semibold", r.net >= -0.1 * r.put.fill ? "text-green-400" : r.net >= -r.put.fill ? "text-amber-300" : "text-red-400")}>{usd(r.net * 100)}</td>
              <td className={TD}>{pc(r.pCallItm)}</td>
              <td className={TD}>{r.putOverCall.toFixed(2)}×</td>
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
