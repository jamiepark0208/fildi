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
import type { RelChip } from "@/lib/research-peers";

const CHIP_TONE = {
  good: "border-green-500/25 text-green-300",
  bad: "border-red-500/25 text-red-300",
  warn: "border-amber-400/25 text-amber-200",
  neutral: "border-[#d4af37]/12 text-zinc-200",
} as const;

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
          <div className={cn("min-w-0 flex-1", embedded ? "space-y-0.5" : "space-y-1.5")}>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span
                className={cn(
                  "text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border",
                  verdictClass,
                )}
              >
                {verdictLabel}
              </span>
              <span className="text-[9px] uppercase tracking-widest text-amber-200/45">{title}</span>
              {subtitle && <span className="text-[9px] font-mono text-zinc-600">{subtitle}</span>}
              {!embedded && (
                <p className="text-[12px] text-zinc-100 leading-snug font-medium line-clamp-2 w-full basis-full">
                  {summaryLine}
                </p>
              )}
              {embedded && (
                <span className="text-[11px] text-zinc-100 font-medium truncate min-w-0 flex-1">
                  {summaryLine}
                </span>
              )}
            </div>
            {chips && chips.length > 0 && (
              <div
                className={cn(
                  embedded
                    ? "flex flex-wrap gap-x-2 gap-y-0.5"
                    : "grid grid-cols-2 sm:grid-cols-3 gap-1",
                )}
              >
                {chips.map((c) =>
                  embedded ? (
                    <span
                      key={c.label}
                      title={c.hint}
                      className={cn("font-mono text-[10px] tabular-nums", CHIP_TONE[c.tone ?? "neutral"])}
                    >
                      <span className="text-zinc-500">{c.label} </span>
                      {c.value}
                    </span>
                  ) : (
                    <span
                      key={c.label}
                      className={cn(
                        "rounded border bg-zinc-950/80 px-1.5 py-1 min-w-0",
                        CHIP_TONE[c.tone ?? "neutral"],
                      )}
                    >
                      <div className="text-[8px] uppercase tracking-wider text-zinc-500 leading-none">{c.label}</div>
                      <div className="font-mono text-[12px] leading-tight truncate">{c.value}</div>
                      {c.hint && (
                        <div className="text-[8.5px] text-zinc-500 leading-tight truncate" title={c.hint}>
                          {c.hint}
                        </div>
                      )}
                    </span>
                  ),
                )}
              </div>
            )}
            {sparkline}
            {howTo && <p className="text-[9px] text-zinc-500 leading-snug">{howTo}</p>}
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
            <DialogDescription className="text-zinc-500 text-[11px]">
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
