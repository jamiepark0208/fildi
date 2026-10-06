// Stock DB admin panel: LSEG vs gold disagreements from gold_audit (read-only; a human queues refetches).
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type GoldAuditRow = {
  ticker: string;
  field: string;
  gold_value: number | string | null;
  gold_source: string | null;
  lseg_value: number | string | null;
  diff: number | null;
  severity: string;
  checked_at: string | null;
};

export function VendorCrossCheckPanel({ queuePending, onQueueRefetch }: {
  queuePending: boolean;
  onQueueRefetch: (v: { ticker: string; field: string; sources: string[] }) => void;
}) {
  const [vendorExpanded, setVendorExpanded] = useState(false);
  const { data: vendorAudit } = useQuery<{ available: boolean; rows: GoldAuditRow[]; reason?: string }>({
    queryKey: ["lseg-gold-audit"],
    queryFn: async () => {
      const r = await fetch("/api/research/lseg/audit", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  const vendorRows = vendorAudit?.rows ?? [];

  return (
    <div className="rounded-md border border-violet-500/30 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <button
        type="button"
        onClick={() => setVendorExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-amber-500/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          {vendorExpanded ? <ChevronDown className="h-3 w-3 text-amber-200/40" /> : <ChevronRight className="h-3 w-3 text-amber-200/40" />}
          <AlertTriangle className="h-3 w-3 text-violet-400" />
          <span className="font-semibold text-violet-300/90 uppercase tracking-wide text-[11px]">Vendor cross-check</span>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-violet-500/15 text-violet-300 border-violet-500/30">
            {vendorRows.length}
          </span>
        </div>
        <span className="text-amber-200/40">LSEG vs gold · never overwrites · queue refetch if you agree</span>
      </button>
      {vendorExpanded && (
        <div className="border-t border-[#d4af37]/20">
          {!vendorAudit?.available ? (
            <p className="text-[11px] text-amber-200/50 px-3 py-2">
              {vendorAudit?.reason ?? "Run research/lseg/audit_gold.py to populate gold_audit."}
            </p>
          ) : vendorRows.length === 0 ? (
            <p className="text-[11px] text-amber-200/50 px-3 py-2">No disagreements in gold_audit.</p>
          ) : (
            <div className="overflow-auto max-h-64">
              <table className="text-xs w-full border-collapse">
                <thead className="sticky top-0 bg-black text-[#d4af37]">
                  <tr className="border-b border-[#d4af37]/25">
                    <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Ticker</th>
                    <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Field</th>
                    <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Gold</th>
                    <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">LSEG</th>
                    <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Sev</th>
                    <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {vendorRows.slice(0, 80).map((row) => {
                    const src = (row.gold_source ?? "yahoo").toLowerCase();
                    const sources = src.includes("fmp") ? ["fmp"] : src.includes("yahoo") ? ["yahoo"] : ["yahoo", "fmp"];
                    return (
                      <tr key={`${row.ticker}:${row.field}`} className="bg-zinc-900/70 even:bg-zinc-800/60">
                        <td className="px-2.5 py-1 font-mono font-semibold text-white">{row.ticker}</td>
                        <td className="px-2.5 py-1 font-mono text-amber-200/50">{row.field}</td>
                        <td className="px-2.5 py-1 text-right font-mono tabular-nums text-amber-200/50" title={row.gold_source ?? ""}>
                          {row.gold_value != null ? String(row.gold_value) : "—"}
                        </td>
                        <td className="px-2.5 py-1 text-right font-mono tabular-nums text-amber-200/50">
                          {row.lseg_value != null ? String(row.lseg_value) : "—"}
                        </td>
                        <td className={cn(
                          "px-2.5 py-1",
                          row.severity === "high" ? "text-red-400" : "text-amber-200/50",
                        )}>
                          {row.severity}
                        </td>
                        <td className="px-2.5 py-1 text-right">
                          <button
                            type="button"
                            disabled={queuePending}
                            onClick={() =>
                              onQueueRefetch({
                                ticker: row.ticker,
                                field: row.field,
                                sources,
                              })
                            }
                            className="text-[10px] px-2 py-0.5 border border-sky-500/30 rounded text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
                            title="Queue gold refetch (FMP budget 250/day — human decides)"
                          >
                            Queue refetch
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] text-amber-200/40 px-3 py-1.5 border-t border-zinc-800">
            Auditor only — does not write FIELD_DEFS / fund scores. Dual-class share counts often disagree by design.
          </p>
        </div>
      )}
    </div>
  );
}
