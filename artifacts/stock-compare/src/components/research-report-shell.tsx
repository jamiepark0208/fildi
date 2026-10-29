/**
 * Compact research card → click opens a centered scrollable report dialog
 * (same pattern as Profile account details — not a right-side sheet).
 */
import { type ReactNode, useState } from "react";
import { ChevronRight } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatMdYy } from "@/lib/format";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RelChip } from "@/lib/research-peers";

const CHIP_TONE = {
  good: "text-emerald-300",
  bad: "text-red-300",
  warn: "text-amber-200",
  neutral: "text-white",
} as const;

const CHIP_TIP: Record<string, string> = {
  "FY1 drift": "How much FY1 EPS consensus moved — up = Street lifting numbers.",
  Breadth: "Net share of analysts raising vs cutting. Negative = more cuts.",
  SUE: "Standardized unexpected earnings — recent beat/miss streak vs Street.",
  IV: "Option implied vol — higher = market pricing bigger moves.",
  "Peer #1 br": "Peer with the strongest revision breadth in the group.",
};

export function ResearchReportShell({
  lane,
  title,
  subtitle,
  verdictLabel,
  verdictClass,
  summaryLine,
  howTo,
  chips,
  sparkline,
  compactBody,
  report,
  disabled,
  /** Inside Street box — no nested border/padding; maximize fill. */
  embedded,
}: {
  lane: "wrds" | "lseg";
  title: string;
  subtitle?: string;
  verdictLabel: string;
  verdictClass: string;
  summaryLine: string;
  /** One-line “how to read” under chips. */
  howTo?: string;
  chips?: RelChip[];
  /** Tiny chart sitting in the compact card (e.g. sparkline). */
  sparkline?: ReactNode;
  /** Extra compact lines under the summary (optional). */
  compactBody?: ReactNode;
  report: ReactNode;
  disabled?: boolean;
  embedded?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className={cn(
          "w-full text-left group",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d4af37]/50",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          embedded
            ? "rounded-none border-0 bg-transparent px-0 py-0.5 hover:bg-white/[0.03]"
            : "rounded-md border border-[#d4af37]/20 bg-zinc-900/50 px-2.5 py-2 hover:border-[#d4af37]/45 hover:bg-zinc-900/80 transition-colors",
        )}
      >
        <div className="flex items-start gap-1.5">
          <div className={cn("min-w-0 flex-1", embedded ? "space-y-1" : "space-y-1.5")}>
            <div className="flex items-center gap-1.5 flex-wrap min-w-0">
              <span
                className={cn(
                  "text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border shrink-0",
                  verdictClass,
                )}
              >
                {verdictLabel}
              </span>
              <span className="text-[12px] font-mono font-bold text-[#d4af37] tracking-tight shrink-0">
                {title}
              </span>
              {subtitle && (
                <span className="text-[11px] font-mono text-amber-50 shrink-0">
                  {/^\d{4}-\d{2}-\d{2}/.test(subtitle) ? formatMdYy(subtitle.slice(0, 10)) : subtitle}
                </span>
              )}
              <p
                className={cn(
                  "text-[12px] text-white leading-snug font-medium w-full basis-full",
                  embedded ? "line-clamp-3" : "line-clamp-2",
                )}
                title={summaryLine}
              >
                {summaryLine}
              </p>
            </div>
            {chips && chips.length > 0 && (
              embedded ? (
                <div className={GRID_WRAP}>
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className={GRID_HEADER}>
                        <th className={cn(GRID_TH, "text-left")}>Metric</th>
                        <th className={cn(GRID_TH, "text-right")}>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {chips.map((c, i) => {
                        const tip = c.hint || CHIP_TIP[c.label] || c.label;
                        return (
                          <Tooltip key={c.label} delayDuration={150}>
                            <TooltipTrigger asChild>
                              <tr className={cn(gridRow(i), "cursor-help")}>
                                <td className={cn(GRID_TD, "text-[#d4af37] text-left text-[10px] font-semibold uppercase")}>
                                  {c.label}
                                </td>
                                <td className={cn(GRID_TD, "text-right font-mono font-semibold", CHIP_TONE[c.tone ?? "neutral"])}>
                                  {c.value}
                                </td>
                              </tr>
                            </TooltipTrigger>
                            <TooltipContent
                              side="left"
                              className="max-w-[260px] bg-zinc-950 text-white border border-[#d4af37]/40 text-[11px] leading-snug"
                            >
                              {tip}
                            </TooltipContent>
                          </Tooltip>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                  {chips.map((c) => (
                    <span
                      key={c.label}
                      className={cn(
                        "rounded border bg-zinc-950/80 px-1.5 py-1 min-w-0",
                        CHIP_TONE[c.tone ?? "neutral"],
                      )}
                    >
                      <div className="text-[8px] uppercase tracking-wider text-[#d4af37]/80 leading-none">{c.label}</div>
                      <div className="font-mono text-[12px] leading-tight truncate text-white">{c.value}</div>
                      {c.hint && (
                        <div className="text-[8.5px] text-amber-50/70 leading-tight truncate" title={c.hint}>
                          {c.hint}
                        </div>
                      )}
                    </span>
                  ))}
                </div>
              )
            )}
            {sparkline}
            {howTo && <p className="text-[9px] text-amber-50/70 leading-snug">{howTo}</p>}
            {compactBody}
          </div>
          <span className="shrink-0 flex flex-col items-center gap-0.5 text-[10px] text-[#d4af37]/80 group-hover:text-[#d4af37] mt-0.5">
            <ChevronRight className="w-3.5 h-3.5" />
            {!embedded && <span className="text-[8px] uppercase tracking-wider">Open</span>}
          </span>
        </div>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className={cn(
            "bg-zinc-950 border-[#d4af37]/30 text-zinc-100",
            "w-[calc(100vw-1.5rem)] sm:max-w-2xl md:max-w-3xl",
            "max-h-[85dvh] p-0 gap-0 flex flex-col overflow-hidden",
          )}
        >
          <DialogHeader className="px-4 pt-4 pb-2 border-b border-[#d4af37]/15 shrink-0 space-y-1 text-left">
            <DialogTitle className="text-[#d4af37] text-base tracking-tight">
              {lane === "wrds" ? "WRDS research" : "LSEG research"} · {title}
            </DialogTitle>
            <DialogDescription className="text-amber-100/80 text-[11px]">
              Local cache only. Use Peers tab for sector-relative context — absolute $ levels alone are not comparable.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-3 py-2 text-[11px]">{report}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function ReportSection({
  eyebrow,
  title,
  children,
}: {
  eyebrow?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      {eyebrow && <div className="text-[9px] uppercase tracking-[0.14em] text-amber-200/40">{eyebrow}</div>}
      <h3 className="text-[12px] font-semibold text-zinc-100 border-b border-[#d4af37]/15 pb-1">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}
