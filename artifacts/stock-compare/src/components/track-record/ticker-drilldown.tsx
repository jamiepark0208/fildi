/** A92 — expand a By-Ticker row: model trades + cum curve + real-book wheel. */
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
} from "recharts";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type DrillRec = {
  id: number;
  side: string;
  status: string;
  snapshotDate: string;
  expiry: string;
  strike: number | null;
  premium: number | null;
  pnlPct: number | null;
  pnlPerShare: number | null;
  assigned?: boolean;
  allInPnlPerShare?: number | null;
};

type DrillResp = {
  ticker: string;
  recs: DrillRec[];
  equityCurve: Array<{
    expiry: string;
    side: string;
    cumAllInPct: number;
    cumPremiumPct: number;
  }>;
  wheel: {
    options: number;
    stockRealized: number;
    stockUnrealized: number;
    dividends: number;
    total: number | null;
    costUnknown: boolean;
  } | null;
};

function money(v: number | null | undefined): string {
  if (v == null) return "—";
  const s = Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
  return `${v >= 0 ? "+" : "−"}$${s}`;
}

export function TickerDrilldown({ ticker, onClose }: { ticker: string; onClose: () => void }) {
  const { data, isLoading, isError } = useQuery<DrillResp>({
    queryKey: ["track-record", "ticker", ticker],
    queryFn: async () => {
      const res = await fetch(`/api/track-record/ticker/${encodeURIComponent(ticker)}`);
      if (!res.ok) throw new Error("ticker drill failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const w = data?.wheel;

  return (
    <div className="rounded-md border border-[#d4af37]/30 bg-zinc-950/95 p-3 space-y-2 shadow-lg shadow-black/40">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-[#d4af37] uppercase tracking-wide">
          {ticker} · drill-down
        </h3>
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-amber-200/50 hover:text-[#d4af37] px-2 py-0.5 border border-[#d4af37]/20 rounded"
        >
          Close
        </button>
      </div>

      {isLoading && (
        <div className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-amber-200/40" />
        </div>
      )}
      {isError && (
        <p className="text-[11px] text-rose-400">Failed to load drill-down.</p>
      )}

      {data && (
        <>
          <div className="flex flex-wrap gap-3 text-[11px] font-mono">
            <span className="text-amber-200/50">Real book wheel</span>
            {w ? (
              <>
                <span>opts {money(w.options)}</span>
                <span>stk {money(w.stockRealized + w.stockUnrealized)}</span>
                <span>div {money(w.dividends)}</span>
                <span className={cn(
                  "font-semibold",
                  w.total == null ? "text-amber-200/60"
                    : w.total >= 0 ? "text-emerald-400" : "text-rose-400",
                )}>
                  total {w.total == null ? "cost unknown" : money(w.total)}
                </span>
              </>
            ) : (
              <span className="text-zinc-500">no portfolio_ticker_earnings row</span>
            )}
          </div>

          {(data.equityCurve?.length ?? 0) > 0 && (
            <div className="h-[72px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.equityCurve} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                  <XAxis dataKey="expiry" tick={{ fontSize: 9, fill: "#7dd3fc" }} tickFormatter={(d: string) => d.slice(5)} />
                  <YAxis tick={{ fontSize: 9, fill: "#7dd3fc" }} tickFormatter={(v: number) => `${v.toFixed(0)}%`} />
                  <Tooltip
                    contentStyle={{ background: "#09090b", border: "1px solid #d4af3740", fontSize: 11 }}
                    formatter={(v: number, key: string) => [`${Number(v).toFixed(2)}%`, key === "cumAllInPct" ? "All-in" : "Premium"]}
                  />
                  <Area type="monotone" dataKey="cumAllInPct" stroke="#38bdf8" fill="#38bdf822" strokeWidth={1.5} />
                  <Area type="monotone" dataKey="cumPremiumPct" stroke="#a78bfa" fill="none" strokeWidth={1} strokeDasharray="3 2" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="overflow-x-auto max-h-[220px] overflow-y-auto">
            <table className="w-full text-[11px] font-mono">
              <thead className="sticky top-0 bg-black text-[#d4af37]/80">
                <tr>
                  <th className="text-left px-1.5 py-1">Side</th>
                  <th className="text-left px-1.5 py-1">Status</th>
                  <th className="text-right px-1.5 py-1">Strike</th>
                  <th className="text-right px-1.5 py-1">Prem</th>
                  <th className="text-right px-1.5 py-1">Exp</th>
                  <th className="text-right px-1.5 py-1">P&L%</th>
                  <th className="text-right px-1.5 py-1">$/sh</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {data.recs.map((r) => (
                  <tr key={r.id} className="hover:bg-amber-500/5">
                    <td className="px-1.5 py-1 capitalize text-amber-200/70">{r.side}</td>
                    <td className={cn(
                      "px-1.5 py-1",
                      r.status === "WIN" ? "text-emerald-400"
                        : r.status === "LOSS" ? "text-rose-400"
                          : r.status === "ASSIGNED" ? "text-amber-300" : "text-zinc-400",
                    )}>
                      {r.status}{r.assigned ? "·stk" : ""}
                    </td>
                    <td className="px-1.5 py-1 text-right">{r.strike ?? "—"}</td>
                    <td className="px-1.5 py-1 text-right">{r.premium != null ? r.premium.toFixed(2) : "—"}</td>
                    <td className="px-1.5 py-1 text-right">{r.expiry.slice(5)}</td>
                    <td className="px-1.5 py-1 text-right">{r.pnlPct != null ? `${r.pnlPct.toFixed(1)}%` : "—"}</td>
                    <td className="px-1.5 py-1 text-right">
                      {r.allInPnlPerShare != null ? r.allInPnlPerShare.toFixed(2)
                        : r.pnlPerShare != null ? r.pnlPerShare.toFixed(2) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-amber-200/35">
            Solid = all-in cum (day-10 assignment) · dashed = premium-only. Wheel = real book (RH export), not model recs.
          </p>
        </>
      )}
    </div>
  );
}
