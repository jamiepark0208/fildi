import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EnrichmentRun } from "./stock-db-types";
import { runStatusBadge, runDuration } from "./stock-db-formatters";
import { coverageColor } from "./stock-db-palette";

// ── Pipeline health panel ─────────────────────────────────────────────────────
// Extracted verbatim from StockDBTab's "Pipeline health" block — purely
// presentational (reads only props), so it was safe to pull out without
// entangling the mutation/query state that lives in the parent.

interface PipelineHealthPanelProps {
  runs: EnrichmentRun[];
  latestRun: EnrichmentRun;
  pipelineExpanded: boolean;
  setPipelineExpanded: (updater: (v: boolean) => boolean) => void;
}

export function PipelineHealthPanel({ runs, latestRun, pipelineExpanded, setPipelineExpanded }: PipelineHealthPanelProps) {
  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <button
        onClick={() => setPipelineExpanded(v => !v)}
        className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-amber-500/5 transition-colors"
      >
        <div className="flex items-center gap-2">
          {pipelineExpanded ? <ChevronDown className="h-3 w-3 text-amber-200/40" /> : <ChevronRight className="h-3 w-3 text-amber-200/40" />}
          <span className="font-semibold text-[#d4af37]/80 uppercase tracking-wide text-[11px]">Pipeline Health</span>
          <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border", runStatusBadge(latestRun.status))}>{latestRun.status}</span>
          <span className="text-amber-200/40">
            {new Date(latestRun.startedAt).toLocaleString()} · {latestRun.trigger} · {runDuration(latestRun)}
          </span>
        </div>
        {latestRun.coverageBefore != null && latestRun.coverageAfter != null && (
          <span className="text-amber-200/40 tabular-nums">
            Coverage <span className={coverageColor(Number(latestRun.coverageBefore))}>{Number(latestRun.coverageBefore).toFixed(1)}%</span>
            {" → "}
            <span className={cn("font-medium", coverageColor(Number(latestRun.coverageAfter)))}>{Number(latestRun.coverageAfter).toFixed(1)}%</span>
          </span>
        )}
      </button>
      {pipelineExpanded && (
        <div className="border-t border-[#d4af37]/20 overflow-auto max-h-64">
          <table className="text-xs w-full border-collapse">
            <thead className="sticky top-0 bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/25">
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Started</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Trigger</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Status</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Duration</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Coverage</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Flag audit</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {runs.map(run => (
                <tr key={run.id} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 whitespace-nowrap text-white">{new Date(run.startedAt).toLocaleString()}</td>
                  <td className="px-2.5 py-1 text-amber-200/50">{run.trigger}</td>
                  <td className="px-2.5 py-1">
                    <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border", runStatusBadge(run.status))}>{run.status}</span>
                  </td>
                  <td className="px-2.5 py-1 tabular-nums text-amber-200/50">{runDuration(run)}</td>
                  <td className="px-2.5 py-1 tabular-nums text-amber-200/50">
                    {run.coverageBefore != null && run.coverageAfter != null
                      ? `${Number(run.coverageBefore).toFixed(1)}% → ${Number(run.coverageAfter).toFixed(1)}%`
                      : "—"}
                  </td>
                  <td className="px-2.5 py-1 tabular-nums text-amber-200/50">
                    {run.flagAuditOrphaned != null || run.flagAuditMissing != null
                      ? `${run.flagAuditOrphaned ?? 0} orphaned / ${run.flagAuditMissing ?? 0} missing`
                      : "—"}
                  </td>
                  <td className="px-2.5 py-1 text-red-400 max-w-xs truncate" title={run.error ?? undefined}>{run.error ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
