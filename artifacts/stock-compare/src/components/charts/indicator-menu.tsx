import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type IndicatorMenuItem = { id: string; label: string; title: string; busy?: boolean };

/** The Indicators dropdown shared by the Breakdown chart and the Live chart. */
export function IndicatorMenu({
  items, active, onToggle, compact, header, footer, className,
}: {
  items: IndicatorMenuItem[];
  active: ReadonlySet<string>;
  onToggle: (id: string) => void;
  compact?: boolean;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  return (
    <div className={cn("relative shrink-0", className)} ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1 rounded border font-semibold shrink-0",
          compact
            ? "px-1.5 py-0.5 text-[10px] border-zinc-600 bg-zinc-950 text-white hover:border-zinc-400"
            : "px-2 py-1 text-xs border-border text-white",
          active.size > 0 && "border-[#d4af37]/70 text-[#d4af37]",
        )}
      >
        Indicators
        {active.size > 0 ? ` ${active.size}` : ""}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded border border-[#d4af37]/30 bg-zinc-950 p-1.5 text-white shadow-md">
          <p className="px-1 pb-1 text-[9px] uppercase tracking-wide text-amber-100/70">Chart overlays</p>
          {header}
          <div className="flex flex-col">
            {items.map((ind) => {
              const on = active.has(ind.id);
              return (
                <button
                  key={ind.id}
                  type="button"
                  onClick={() => onToggle(ind.id)}
                  className="flex items-start gap-2 rounded px-1 py-1 text-left hover:bg-zinc-900"
                >
                  <span className={cn(
                    "mt-0.5 h-3.5 w-3.5 shrink-0 rounded border text-[9px] leading-none flex items-center justify-center",
                    on ? "border-[#d4af37] bg-[#d4af37] text-black" : "border-zinc-500",
                  )}>{on ? "✓" : ""}</span>
                  <span className="min-w-0">
                    <span className={cn("block text-[11px] font-semibold", on ? "text-white" : "text-zinc-300")}>
                      {ind.label}{ind.busy ? "…" : ""}
                    </span>
                    <span className="block text-[10px] text-amber-100/70 leading-snug">{ind.title}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {footer}
        </div>
      )}
    </div>
  );
}
