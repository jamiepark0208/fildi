import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import type { CoverageTone, GuideStatusChips } from "@/hooks/use-guide-status";

function coverageBadgeClass(tone: CoverageTone): string {
  if (tone === "good") return "bg-green-500/15 text-green-400 border-green-500/30";
  if (tone === "partial") return "bg-yellow-500/15 text-yellow-400 border-yellow-500/30";
  return "bg-secondary text-muted-foreground border-border";
}

function sourceBadgeClass(name: string, active: boolean): string {
  if (!active) return "bg-secondary/50 text-muted-foreground border-border";
  if (name === "FactSet") return "bg-green-500/15 text-green-400 border-green-500/30";
  if (name === "FMP") return "bg-blue-500/15 text-blue-400 border-blue-500/30";
  return "bg-primary/10 text-foreground border-primary/30";
}

export function StatusChipRow({ chips, compact }: { chips?: GuideStatusChips; compact?: boolean }) {
  if (!chips) return null;

  const size = compact ? "text-sm px-2.5 py-1" : "text-base px-3 py-1.5";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.peerRanked && (
        <Badge variant="outline" className={cn(size, "font-medium text-foreground border-border")}>
          Peer-ranked
        </Badge>
      )}
      {chips.lastRefresh && chips.lastRefresh !== "Live at scan" && (
        <Badge variant="outline" className={cn(size, "font-medium text-foreground border-border")}>
          Last refresh: {chips.lastRefresh}
        </Badge>
      )}
      {chips.lastRefresh === "Live at scan" && (
        <Badge variant="outline" className={cn(size, "font-medium text-foreground border-border")}>
          {chips.lastRefresh}
        </Badge>
      )}
      {chips.coverage.label && (
        <Badge variant="outline" className={cn(size, "font-semibold", coverageBadgeClass(chips.coverage.tone))}>
          Coverage: {chips.coverage.label}
        </Badge>
      )}
      {chips.sources.map(s => (
        <Badge
          key={s.name}
          variant="outline"
          className={cn(size, "font-semibold", sourceBadgeClass(s.name, s.active))}
        >
          {s.name}: {s.active ? "Active" : "Inactive"}
          {s.detail && (
            <span className={cn("ml-1 font-normal", s.name === "FMP" ? "text-yellow-400" : "text-foreground/80")}>
              ({s.detail})
            </span>
          )}
        </Badge>
      ))}
      {chips.stale && (
        <Badge variant="outline" className={cn(size, "font-semibold bg-amber-500/15 text-amber-400 border-amber-500/30")}>
          Stale
        </Badge>
      )}
    </div>
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
      <div className="mb-4">
        <StatusChipRow chips={chips} />
      </div>
    );
  }
  if (text) {
    return (
      <p className={cn(
        "text-sm font-mono tabular-nums mb-4",
        warn ? "text-amber-400" : "text-foreground",
      )}>
        {text}
      </p>
    );
  }
  return null;
}

export type TabStatusHeaderProps = Props;
