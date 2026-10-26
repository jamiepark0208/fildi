/**
 * Skim primitives for research reports.
 * Do NOT put generic textbook What/Why copy here — ticker-specific reasoning only at call sites.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Term({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-[#d4af37]">{children}</span>;
}
export function Good({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-green-400">{children}</span>;
}
export function Bad({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-red-400">{children}</span>;
}
export function Warn({ children }: { children: ReactNode }) {
  return <span className="font-semibold text-amber-300">{children}</span>;
}
export function Num({ children }: { children: ReactNode }) {
  return <span className="font-mono font-semibold text-zinc-100">{children}</span>;
}
export function Em({ children }: { children: ReactNode }) {
  return <span className="italic text-amber-100/70">{children}</span>;
}
export function U({ children }: { children: ReactNode }) {
  return <span className="underline decoration-[#d4af37]/50 underline-offset-2">{children}</span>;
}

const TONE_BORDER = {
  good: "border-green-500/30 bg-green-500/5",
  bad: "border-red-500/30 bg-red-500/5",
  warn: "border-amber-400/30 bg-amber-400/5",
  neutral: "border-[#d4af37]/12 bg-zinc-900/50",
} as const;

/** Compact metric cell — optional `note` only when it is ticker-specific. */
export function WhyMetric({
  label,
  value,
  sub,
  tone = "neutral",
  note,
  children,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: keyof typeof TONE_BORDER;
  /** Ticker-specific one-liner only. Never generic glossary. */
  note?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={cn("rounded border px-2.5 py-2 space-y-1", TONE_BORDER[tone])}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#d4af37]">{label}</span>
        <span className="font-mono text-[14px] font-semibold text-white shrink-0">{value}</span>
      </div>
      {sub && <div className="text-[9.5px] text-amber-100/80 font-mono">{sub}</div>}
      {note && <div className="text-[10.5px] text-amber-50 leading-snug">{note}</div>}
      {children}
    </div>
  );
}

export function WhyCallout({
  title,
  tone = "neutral",
  children,
}: {
  title: ReactNode;
  tone?: keyof typeof TONE_BORDER;
  children?: ReactNode;
}) {
  return (
    <div className={cn("rounded border px-2.5 py-2 space-y-1", TONE_BORDER[tone])}>
      <div className="text-[12px] font-semibold text-zinc-100 leading-snug">{title}</div>
      {children && <div className="text-[10.5px] text-amber-100/85 leading-snug space-y-1">{children}</div>}
    </div>
  );
}
