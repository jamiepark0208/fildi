// ── Coverage color helpers ─────────────────────────────────────────────────────

export function coverageColor(pct: number): string {
  return pct < 50 ? "text-red-400" : pct < 80 ? "text-amber-400" : "text-green-400";
}

export function coverageBarColor(pct: number): string {
  return pct < 50 ? "bg-red-500/70" : pct < 80 ? "bg-amber-500/60" : "bg-green-500/60";
}

// ── Sector color palettes ─────────────────────────────────────────────────────

export interface SectorPalette { bg: string; border: string; text: string; badge: string; chevron: string }

export const SECTOR_PALETTE: Record<string, SectorPalette> = {
  technology:    { bg: "bg-blue-950/90",    border: "border-l-blue-500",    text: "text-blue-200",    badge: "bg-blue-500/25 text-blue-300 border border-blue-500/40",    chevron: "text-blue-400" },
  financial:     { bg: "bg-emerald-950/90", border: "border-l-emerald-500", text: "text-emerald-200", badge: "bg-emerald-500/25 text-emerald-300 border border-emerald-500/40", chevron: "text-emerald-400" },
  healthcare:    { bg: "bg-violet-950/90",  border: "border-l-violet-500",  text: "text-violet-200",  badge: "bg-violet-500/25 text-violet-300 border border-violet-500/40",  chevron: "text-violet-400" },
  energy:        { bg: "bg-orange-950/90",  border: "border-l-orange-500",  text: "text-orange-200",  badge: "bg-orange-500/25 text-orange-300 border border-orange-500/40",  chevron: "text-orange-400" },
  consumer:      { bg: "bg-rose-950/90",    border: "border-l-rose-500",    text: "text-rose-200",    badge: "bg-rose-500/25 text-rose-300 border border-rose-500/40",    chevron: "text-rose-400" },
  industrial:    { bg: "bg-cyan-950/90",    border: "border-l-cyan-500",    text: "text-cyan-200",    badge: "bg-cyan-500/25 text-cyan-300 border border-cyan-500/40",    chevron: "text-cyan-400" },
  real_estate:   { bg: "bg-yellow-950/90",  border: "border-l-yellow-500",  text: "text-yellow-200",  badge: "bg-yellow-500/25 text-yellow-300 border border-yellow-500/40",  chevron: "text-yellow-400" },
  utilities:     { bg: "bg-teal-950/90",    border: "border-l-teal-500",    text: "text-teal-200",    badge: "bg-teal-500/25 text-teal-300 border border-teal-500/40",    chevron: "text-teal-400" },
  materials:     { bg: "bg-lime-950/90",    border: "border-l-lime-500",    text: "text-lime-200",    badge: "bg-lime-500/25 text-lime-300 border border-lime-500/40",    chevron: "text-lime-400" },
  communication: { bg: "bg-indigo-950/90",  border: "border-l-indigo-500",  text: "text-indigo-200",  badge: "bg-indigo-500/25 text-indigo-300 border border-indigo-500/40",  chevron: "text-indigo-400" },
};
export const DEFAULT_SECTOR_PALETTE: SectorPalette = { bg: "bg-zinc-900/90", border: "border-l-zinc-500", text: "text-zinc-200", badge: "bg-zinc-500/25 text-zinc-300 border border-zinc-500/40", chevron: "text-zinc-400" };

export function getSectorPalette(sectorId: string): SectorPalette {
  const k = Object.keys(SECTOR_PALETTE).find(key => sectorId.toLowerCase().includes(key));
  return k ? SECTOR_PALETTE[k] : DEFAULT_SECTOR_PALETTE;
}
