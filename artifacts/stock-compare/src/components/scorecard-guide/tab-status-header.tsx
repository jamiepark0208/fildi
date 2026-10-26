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
      cls: "text-[#d4af37]",
    });
  }
  if (chips.stale) items.push({ key: "stale", label: "Stale", cls: "text-amber-300 font-semibold" });

  if (items.length === 0) return null;

  return (
    <span className="text-[11px] font-mono tabular-nums">
      {items.map((it, i) => (
        <span key={it.key}>
          {i > 0 && <span className="text-white/40"> · </span>}
          <span className={it.cls}>{it.label}</span>
        </span>
      ))}
    </span>
  );
}

type Props = {
  chips?: GuideStatusChips;
  /** @deprecated use chips */
  text?: string;
  warn?: boolean;
  /** Sit beside Fundamental/Technical/Options tabs instead of a lonely row */
  inline?: boolean;
};

export function TabStatusHeader({ chips, text, warn, inline }: Props) {
  if (chips) {
    return (
      <div className={cn(inline ? "flex items-center h-7" : "mb-1")}>
        <StatusChipRow chips={chips} />
      </div>
    );
  }
  if (text) {
    return (
      <p className={cn(
        "text-xs font-mono tabular-nums",
        inline ? "flex items-center h-7" : "mb-1",
        warn ? "text-amber-300" : "text-[#d4af37]",
      )}>
        {text.startsWith("Last refresh:") ? text.replace(/^Last refresh:/, "As of") : text}
      </p>
    );
  }
  return null;
}

export type TabStatusHeaderProps = Props;
