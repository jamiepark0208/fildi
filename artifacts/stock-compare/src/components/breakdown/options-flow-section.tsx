/**
 * Breakdown › Options flow (A396, north-star #2) — big OPRA prints (≥ $25k premium) for this ticker, latest published day.
 * GET /api/stocks/:t/options-flow (stored LSE prints). Trades only, no bid/ask → side unknown. Display only, untested edge.
 */
import { useQuery } from "@tanstack/react-query";
import { GRID_HEADER, GRID_TD, GRID_TH, GRID_WRAP, gridRow } from "@/lib/score-explain-format";
import { formatMdYy } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { usd } from "@/components/breakdown/congress-section";

export type FlowContract = {
  occ: string; side: "call" | "put" | null; strike: number | null; expiry: string | null; dte: number | null;
  premium: number; size: number; prints: number; iv: number | null; delta: number | null; volume: number | null; oi: number | null;
};
export type FlowDay = {
  day: string; ticker: string; prints: number; callPremium: number; putPremium: number; totalPremium: number;
  putShare: number | null; blocks: number; bursts: number; maxPrint: number | null; xNormal: number | null;
  baselineDays: number; top: FlowContract[];
};
type Print = { occ: string; ts: string; side: string; strike: number | null; expiry: string | null; dte: number | null;
  size: number | null; price: number | null; premium: number | null; iv: number | null; delta: number | null; venue: string };
type View = { latest: FlowDay | null; series: FlowDay[]; prints: Print[] };

export const FLOW_TIP =
  "Every OPRA options trade ≥ $25k premium (London Strategic Edge, published ~1 day late). × normal = that day's premium ÷ the name's median of the prior ≤ 20 days. Block = one print ≥ $250k. Burst = same contract on ≥ 3 venues inside 2 s (sweep-like). Vol/OI from our stored chain when the contract is in it. Trades carry no bid/ask, so whether a print was bought or sold is unknown — a big put print can be a put SELLER. Untested as an edge — display only.";

export function FlowChip() {
  return (
    <DataTip tip={FLOW_TIP}>
      <span className="rounded border border-amber-400/40 px-1 text-[9px] uppercase tracking-wide text-amber-300">side unknown · untested</span>
    </DataTip>
  );
}

export const xCls = (x: number | null) => (x == null ? "text-white" : x >= 3 ? "text-[#d4af37] font-semibold" : x >= 1.5 ? "text-amber-200" : "text-white");
export const xTxt = (x: number | null) => (x == null ? "—" : `${x >= 10 ? x.toFixed(0) : x.toFixed(1)}×`);
const sideCls = (s: string | null) => (s === "call" ? "text-green-400" : s === "put" ? "text-red-400" : "text-white");
/** Expiry as m/d/yy. Not formatMdYy: it blanks years > next year (headline junk guard), and LEAPS run to 2029. */
export const expTxt = (iso: string | null) => {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${Number(m[2])}/${Number(m[3])}/${m[1]!.slice(2)}` : "—";
};
const contract = (c: { side: string | null; strike: number | null; expiry: string | null }) =>
  `${c.strike ?? "—"}${c.side === "call" ? "C" : c.side === "put" ? "P" : ""} ${expTxt(c.expiry)}`;

function useFlow(ticker: string) {
  return useQuery({
    queryKey: ["options-flow", ticker],
    queryFn: async (): Promise<View> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/options-flow?days=20`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60 * 60_000,
  });
}

export function OptionsFlowHeaderStats({ ticker }: { ticker: string }) {
  const { data } = useFlow(ticker);
  const l = data?.latest;
  return (
    <div className="flex items-center gap-2">
      {l && l.prints > 0 && <span className={cn("text-[10px]", xCls(l.xNormal))}>{usd(l.totalPremium)} · {xTxt(l.xNormal)}</span>}
      <FlowChip />
    </div>
  );
}

export function OptionsFlowSection({ ticker }: { ticker: string }) {
  const { data, isLoading } = useFlow(ticker);
  if (isLoading) return <p className="text-[10px] text-amber-100">Loading options flow…</p>;
  const l = data?.latest;
  if (!l || l.prints === 0) return <p className="text-[10px] text-amber-100">No option prints ≥ $25k for {ticker}{l ? ` on ${formatMdYy(l.day)}` : ""}.</p>;
  const hist = (data?.series ?? []).slice(1).map((d) => d.totalPremium).sort((a, b) => a - b);
  const med = hist.length ? hist[Math.floor(hist.length / 2)] : null;
  return (
    <div className="space-y-1">
      <p className="text-[10px] leading-snug text-white">
        {formatMdYy(l.day)}: {usd(l.totalPremium)} in {l.prints} prints (<span className={xCls(l.xNormal)}>{xTxt(l.xNormal)} normal</span>
        {med != null ? `, median ${usd(med)}` : ""}) · <span className="text-green-400">calls {usd(l.callPremium)}</span> /{" "}
        <span className="text-red-400">puts {usd(l.putPremium)}</span> · {l.blocks} blocks · {l.bursts} bursts
      </p>
      <div className="text-[9px] uppercase tracking-wide text-[#d4af37]">Top contracts by premium</div>
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-left")}>Contract</th>
              <th className={cn(GRID_TH, "text-right")}>DTE</th>
              <th className={cn(GRID_TH, "text-right")}>Premium</th>
              <th className={cn(GRID_TH, "text-right")}>Size</th>
              <th className={cn(GRID_TH, "text-right")}>Δ</th>
              <th className={cn(GRID_TH, "text-right")}>IV</th>
              <th className={cn(GRID_TH, "text-right")}>
                <DataTip tip="That day's contract volume ÷ open interest, from our stored chain (2–39 DTE contracts only). > 1 = opening size likely.">Vol/OI</DataTip>
              </th>
            </tr>
          </thead>
          <tbody>
            {l.top.map((c, i) => (
              <tr key={c.occ} className={gridRow(i)}>
                <td className={cn(GRID_TD, sideCls(c.side))}>{contract(c)}</td>
                <td className={cn(GRID_TD, "text-right")}>{c.dte ?? "—"}</td>
                <td className={cn(GRID_TD, "text-right")}>{usd(c.premium)}</td>
                <td className={cn(GRID_TD, "text-right")}>{c.size.toLocaleString()}</td>
                <td className={cn(GRID_TD, "text-right")}>{c.delta != null ? c.delta.toFixed(2) : "—"}</td>
                <td className={cn(GRID_TD, "text-right")}>{c.iv != null ? `${(c.iv * 100).toFixed(0)}%` : "—"}</td>
                <td className={cn(GRID_TD, "text-right", c.volume != null && c.oi != null && c.oi > 0 && c.volume > c.oi ? "text-[#d4af37]" : "")}>
                  {c.volume != null && c.oi ? (c.volume / c.oi).toFixed(1) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-[9px] uppercase tracking-wide text-[#d4af37]">Biggest prints</div>
      <div className={cn(GRID_WRAP, "max-h-[200px]")}>
        <table className="w-full border-collapse">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-left")}>Time ET</th>
              <th className={cn(GRID_TH, "text-left")}>Contract</th>
              <th className={cn(GRID_TH, "text-right")}>Size</th>
              <th className={cn(GRID_TH, "text-right")}>Price</th>
              <th className={cn(GRID_TH, "text-right")}>Premium</th>
            </tr>
          </thead>
          <tbody>
            {(data?.prints ?? []).map((p, i) => (
              <tr key={`${p.occ}${p.ts}${i}`} className={gridRow(i)}>
                <td className={GRID_TD}>
                  {new Date(p.ts).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false })}
                </td>
                <td className={cn(GRID_TD, sideCls(p.side))}>
                  <DataTip tip={`venue ${p.venue} · Δ ${p.delta?.toFixed(2) ?? "—"} · IV ${p.iv != null ? (p.iv * 100).toFixed(0) + "%" : "—"}`}>{contract(p)}</DataTip>
                </td>
                <td className={cn(GRID_TD, "text-right")}>{p.size?.toLocaleString() ?? "—"}</td>
                <td className={cn(GRID_TD, "text-right")}>{p.price?.toFixed(2) ?? "—"}</td>
                <td className={cn(GRID_TD, "text-right")}>{p.premium != null ? usd(p.premium) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
