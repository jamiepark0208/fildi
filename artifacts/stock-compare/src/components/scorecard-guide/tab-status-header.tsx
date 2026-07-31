import { cn } from "@/lib/utils";
import type { CoverageTone, GuideStatusChips } from "@/hooks/use-guide-status";

function coverageTextClass(tone: CoverageTone): string {
  if (tone === "good") return "text-green-400";
  if (tone === "partial") return "text-yellow-400";
  return "text-amber-200/50";
}

function sourceTextClass(name: string, active: boolean): string {
  if (!active) return "text-amber-200/30";
  if (name === "FactSet") return "text-green-400";
  if (name === "FMP") return "text-sky-300";
  return "text-[#d4af37]";
}

/** Single-line " · "-separated compact read — replaces the old multi-badge wrapped row. */
export function StatusChipRow({ chips }: { chips?: GuideStatusChips; compact?: boolean }) {
  if (!chips) return null;

  const items: { key: string; label: string; cls: string }[] = [];
  if (chips.peerRanked) items.push({ key: "peer", label: "Peer-ranked", cls: "text-white" });
  if (chips.lastRefresh) {
    items.push({
      key: "refresh",
      label: chips.lastRefresh === "Live at scan" ? chips.lastRefresh : `Refresh: ${chips.lastRefresh}`,
      cls: "text-white",
    });
  }
  if (chips.coverage.label) {
    items.push({ key: "cov", label: `Coverage: ${chips.coverage.label}`, cls: coverageTextClass(chips.coverage.tone) });
  }
  chips.sources.forEach(s => items.push({
    key: s.name,
    label: `${s.name}: ${s.active ? "Active" : "Inactive"}${s.detail ? ` (${s.detail})` : ""}`,
    cls: sourceTextClass(s.name, s.active),
  }));
  if (chips.stale) items.push({ key: "stale", label: "Stale", cls: "text-amber-400 font-semibold" });

  if (items.length === 0) return null;

  return (
    <span className="block text-[11px] font-mono text-amber-200/40">
      {items.map((it, i) => (
        <span key={it.key}>
          {i > 0 && " · "}
          <span className={it.cls}>{it.label}</span>
        </span>
      ))}
    </span>
  );
}

type Props = {
  /** Preferred — structured status badges */
  chips?: GuideStatusChips;
  /** @deprecated use chips — kept for partial deploy / HMR safety */
  text?: string;
  warn?: boolean;
};

/** Per-tab timeliness / coverage strip */
export function TabStatusHeader({ chips, text, warn }: Props) {
  if (chips) {
    return (
      <div className="mb-1">
        <StatusChipRow chips={chips} />
      </div>
    );
  }
  if (text) {
    return (
      <p className={cn(
        "text-xs font-mono tabular-nums mb-1",
        warn ? "text-amber-400" : "text-amber-200/50",
      )}>
        {text}
      </p>
    );
  }
  return null;
}

export type TabStatusHeaderProps = Props;
