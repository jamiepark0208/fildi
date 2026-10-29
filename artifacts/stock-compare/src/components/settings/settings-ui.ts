/** Shared Settings chrome — match API Monitor table style; body text stays bright. */
export const SUI = {
  panel: "space-y-3",
  headRow: "flex items-center justify-between mb-0 gap-2",
  title: "text-xs font-semibold text-white uppercase tracking-wide",
  sub: "text-[10px] text-amber-100 mt-0.5",
  muted: "text-amber-100",
  btn: "flex items-center gap-1.5 text-xs text-white/80 hover:text-white border border-[#d4af37]/20 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50",
  tableWrap: "overflow-x-auto rounded-md border border-[#d4af37]/25",
  table: "w-full text-xs",
  thead: "bg-black text-[#d4af37]",
  th: "text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1",
  thRight: "text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1 whitespace-nowrap",
  tr: "bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors",
  td: "px-2.5 py-1 text-white",
  tdMuted: "px-2.5 py-1 text-amber-100",
  input:
    "rounded border border-[#d4af37]/20 bg-zinc-950 px-2 py-1 text-xs text-white placeholder:text-amber-100/70 focus:outline-none focus:border-[#d4af37]/60",
} as const;
