/**
 * Provenance hover tip — Radix Tooltip (native `title` is flaky in Electron).
 * Affordance: gold dotted underline on hover (desk-terminal), never the "?" help cursor.
 */
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const TIP_CLASS =
  "z-[100] max-w-[280px] whitespace-pre-wrap bg-zinc-950 text-amber-50 border border-[#d4af37]/40 text-[11px] leading-snug px-2.5 py-1.5 shadow-lg shadow-black/40";

/** Quiet until hover — then a gold hairline under the figure. */
const TRIGGER_CLASS =
  "inline-flex items-baseline max-w-full underline-offset-[3px] decoration-dotted decoration-transparent transition-[text-decoration-color] duration-150 hover:underline hover:decoration-[#d4af37]/70";

export function DataTip({
  tip,
  className,
  side = "top",
  children,
}: {
  tip?: string | null;
  className?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}) {
  if (!tip) return <>{children}</>;
  return (
    <Tooltip delayDuration={150} disableHoverableContent>
      <TooltipTrigger asChild>
        <span className={cn(TRIGGER_CLASS, className)}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} sideOffset={6} className={TIP_CLASS}>
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

/** Split free text and wrap numeric tokens with a shared tip (bull/bear lines, etc.). */
const NUM_SPLIT =
  /(\$?\d[\d,]*(?:\.\d+)?%?|[+−-]\d[\d,]*(?:\.\d+)?%?)/g;
const NUM_TOKEN = /^\$?\d[\d,]*(?:\.\d+)?%?$|^[+−-]\d[\d,]*(?:\.\d+)?%?$/;

export function tipWrapNumbers(text: string, tip: string | undefined): ReactNode {
  if (!tip || !text) return text;
  const parts = text.split(NUM_SPLIT);
  if (parts.length === 1) return text;
  return parts.map((p, i) => {
    if (!p) return null;
    if (NUM_TOKEN.test(p)) {
      return (
        <DataTip key={i} tip={tip}>
          <span className="font-mono tabular-nums">{p}</span>
        </DataTip>
      );
    }
    return <span key={i}>{p}</span>;
  });
}
