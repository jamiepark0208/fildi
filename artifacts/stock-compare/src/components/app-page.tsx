/**
 * Standard TopNav + viewport shell for every top-level tab.
 *
 * A127 Lenis owns document wheel. Pages that still use `pt-14` document scroll
 * lose the wheel over overflow-x tables / nested panes (Rankings Overall, etc.).
 * Always put scrollable body in this shell's pane with `data-lenis-prevent`.
 *
 * sticky headers inside `children`: use `top-0` (not `top-14`) — TopNav is outside the pane.
 */
import type { ReactNode } from "react";
import { TopNav } from "@/components/top-nav";
import { cn } from "@/lib/utils";

export function AppPage({
  children,
  className,
  contentClassName,
  /** false = caller owns flex/scroll (Watchlist panels, Macro full-bleed). */
  scroll = true,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
  scroll?: boolean;
}) {
  return (
    <div className={cn("min-h-[100dvh] bg-zinc-900 text-foreground", className)}>
      <TopNav />
      <main className="flex flex-col mt-14 h-[calc(100dvh-3.5rem)] min-h-0 overflow-hidden min-w-0">
        {scroll ? (
          <div
            className={cn(
              "flex-1 min-h-0 overflow-y-auto overscroll-contain [overflow-anchor:none] min-w-0",
              contentClassName,
            )}
            data-lenis-prevent
          >
            {children}
          </div>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
