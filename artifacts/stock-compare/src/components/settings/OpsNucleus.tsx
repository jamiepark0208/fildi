import { useEffect, useMemo, useState } from "react";
import { ExternalLink, FileText, Play } from "lucide-react";
import { cn } from "@/lib/utils";

export type NucleusStatus = "ok" | "warn" | "critical" | "idle" | "running" | "off" | "missing";

export interface NucleusProof {
  lastAt: string | null;
  outcome: string | null;
  writes: string[];
  actions?: { label: string; href?: string; taskId?: string }[];
}

export interface NucleusNode {
  id: string;
  label: string;
  status: NucleusStatus;
  summary: string;
  taskIds: string[];
  proof: NucleusProof;
}

export interface NucleusPayload {
  summary: { critical: number; warn: number; info: number; clean: boolean };
  gates: NucleusNode[];
  workers: NucleusNode[];
}

const DOT: Record<NucleusStatus, string> = {
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  critical: "bg-red-400",
  idle: "bg-zinc-300",
  running: "bg-amber-300 animate-pulse",
  off: "bg-zinc-500",
  missing: "bg-red-400",
};

const PULSE: Record<"clean" | "warn" | "critical", { label: string; className: string; note: string }> = {
  clean: { label: "NOMINAL", className: "text-emerald-400", note: "all clear" },
  warn: { label: "ATTENTION", className: "text-amber-300", note: "needs check" },
  critical: { label: "CRITICAL", className: "text-red-400", note: "fix now" },
};

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Shorten noisy summaries for the chip strip / inspector. */
export function shortSummary(s: string, max = 48): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function goSettingsTab(tab: "api-monitor" | "stockdb") {
  try {
    sessionStorage.setItem("fildi_settings_tab", JSON.stringify(tab));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent("fildi:settings-tab", { detail: tab }));
}

export function nucleusPulse(nucleus: NucleusPayload) {
  const key = nucleus.summary.critical > 0 ? "critical" : nucleus.summary.warn > 0 ? "warn" : "clean";
  const note =
    key === "clean"
      ? PULSE.clean.note
      : [
          nucleus.summary.critical > 0 && `${nucleus.summary.critical} crit`,
          nucleus.summary.warn > 0 && `${nucleus.summary.warn} warn`,
        ]
          .filter(Boolean)
          .join(" · ");
  return { ...PULSE[key], note };
}

function Chip({
  node,
  selected,
  onSelect,
}: {
  node: NucleusNode;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      title={node.summary}
      className={cn(
        "inline-flex items-center gap-1 h-6 px-1.5 rounded border text-[11px] font-medium text-zinc-100 cursor-pointer transition-colors",
        "bg-zinc-900 border-zinc-600 hover:border-zinc-400",
        selected && "border-[#d4af37] bg-[#d4af37]/15 text-white",
        node.status === "critical" && !selected && "border-red-500/60",
        node.status === "warn" && !selected && "border-amber-500/50",
      )}
    >
      <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", DOT[node.status])} />
      {node.label.replace(/^L\d+\s*/, "")}
    </button>
  );
}

export function OpsNucleus({
  nucleus,
  onRun,
  onLogs,
  busyId,
  /** When true, pulse lives in parent toolbar — only chips + inspector here */
  hidePulse = false,
}: {
  nucleus: NucleusPayload;
  onRun: (taskId: string) => void;
  onLogs: (taskId: string) => void;
  busyId: string | null;
  hidePulse?: boolean;
}) {
  const all = useMemo(() => [...nucleus.gates, ...nucleus.workers], [nucleus]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (selectedId && all.some((n) => n.id === selectedId)) return;
    const bad = all.find((n) => n.status === "critical") ?? all.find((n) => n.status === "warn");
    setSelectedId(bad?.id ?? all[0]?.id ?? null);
  }, [all, selectedId]);

  const selected = all.find((n) => n.id === selectedId) ?? null;
  const pulse = nucleusPulse(nucleus);

  function handleAction(a: { label: string; href?: string; taskId?: string }) {
    if (a.href?.startsWith("settings:")) {
      const tab = a.href.slice("settings:".length);
      if (tab === "api-monitor" || tab === "stockdb") goSettingsTab(tab);
      return;
    }
    if (a.taskId) {
      if (/logs/i.test(a.label)) onLogs(a.taskId);
      else onRun(a.taskId);
    }
  }

  return (
    <div className="rounded border border-zinc-600 bg-zinc-950 overflow-hidden">
      {!hidePulse && (
        <div className="flex items-center gap-2 px-2 h-8 border-b border-zinc-700">
          <span className={cn("text-sm font-semibold tracking-tight", pulse.className)}>{pulse.label}</span>
          <span className="text-[11px] text-zinc-300">{pulse.note}</span>
        </div>
      )}

      {/* Gates + workers on one wrapping line */}
      <div className="flex flex-wrap items-center gap-1 px-2 py-1.5">
        {nucleus.gates.map((g) => (
          <Chip key={g.id} node={g} selected={selectedId === g.id} onSelect={() => setSelectedId(g.id)} />
        ))}
        <span className="w-px h-4 bg-zinc-600 mx-0.5 shrink-0" aria-hidden />
        {nucleus.workers.map((w) => (
          <Chip key={w.id} node={w} selected={selectedId === w.id} onSelect={() => setSelectedId(w.id)} />
        ))}
      </div>

      {selected && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 border-t border-zinc-700 bg-zinc-900/80">
          <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", DOT[selected.status])} />
          <span className="text-xs font-semibold text-white">{selected.label}</span>
          <span className="text-[11px] text-zinc-200 truncate min-w-0 flex-1">
            {shortSummary(selected.summary, 56)}
            {selected.proof.outcome ? ` · ${shortSummary(selected.proof.outcome, 32)}` : ""}
          </span>
          <span className="text-[11px] font-mono text-zinc-300 shrink-0">{relativeTime(selected.proof.lastAt)}</span>
          <div className="flex items-center gap-1 shrink-0">
            {(selected.proof.actions ?? []).map((a) => {
              const isLogs = /logs/i.test(a.label);
              const isLink = !!a.href;
              const label = isLink
                ? a.label.replace("API Monitor", "APIs").replace("Stock DB", "DB")
                : a.label.replace(/^Run\s+/i, "").replace(/^Ensure\s+/i, "");
              return (
                <button
                  key={`${a.label}-${a.taskId ?? a.href ?? ""}`}
                  type="button"
                  disabled={!!a.taskId && busyId === a.taskId && !isLogs}
                  onClick={() => handleAction(a)}
                  className={cn(
                    "inline-flex items-center gap-0.5 h-6 px-1.5 rounded text-[11px] font-medium cursor-pointer disabled:opacity-40",
                    isLink || isLogs
                      ? "border border-zinc-500 text-zinc-100 hover:border-zinc-300"
                      : "bg-[#d4af37] text-zinc-950 hover:bg-[#e0c04a]",
                  )}
                >
                  {isLink ? <ExternalLink className="w-3 h-3" /> : isLogs ? <FileText className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  {label}
                </button>
              );
            })}
            {selected.taskIds[0] &&
              !(selected.proof.actions ?? []).some((a) => a.taskId === selected.taskIds[0] && /logs/i.test(a.label)) && (
                <button
                  type="button"
                  onClick={() => onLogs(selected.taskIds[0]!)}
                  className="inline-flex items-center gap-0.5 h-6 px-1.5 rounded text-[11px] font-medium border border-zinc-500 text-zinc-100 cursor-pointer"
                >
                  <FileText className="w-3 h-3" /> Logs
                </button>
              )}
          </div>
        </div>
      )}
    </div>
  );
}
