/**
 * Click-to-expand chart shell for Macro Regime Health (3-up grid → centered overlay).
 */
import { useEffect, useId, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

export function ExpandableChartFrame({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "group relative w-full text-left rounded-md border border-[#d4af37]/20 bg-zinc-950/80",
          "hover:border-[#d4af37]/45 hover:bg-zinc-900/80 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d4af37]/50",
          className,
        )}
        title="Click to enlarge"
      >
        <div className="pointer-events-none">{children}</div>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 p-4 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onClick={() => setOpen(false)}
        >
          <div
            className="relative w-full max-w-5xl max-h-[90vh] overflow-auto rounded-md border border-[#d4af37]/35 bg-zinc-950 shadow-2xl shadow-black/80 p-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-2">
              <h3 id={titleId} className="text-sm font-semibold text-[#d4af37]">{title}</h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="ml-auto p-1 rounded text-amber-200/50 hover:text-amber-100 hover:bg-white/5"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="min-h-[360px]">{children}</div>
          </div>
        </div>
      )}
    </>
  );
}
