import { cn } from "@/lib/utils";
import type { GuideStatusChips } from "@/hooks/use-guide-status";

/** Single-line status — as-of + stale only (vendor health lives on Settings › API). */
export function StatusChipRow({ chips }: { chips?: GuideStatusChips; compact?: boolean }) {
  if (!chips) return null;

  const items: { key: string; label: string; cls: string }[] = [];
  if (chips.lastRefresh) {
    items.push({
      key: "refresh",
      label: chips.lastRefresh === "Live at scan" ? chips.lastRefresh : `As of ${chips.lastRefresh}`,
      cls: "text-white/80",
    });
  }
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
