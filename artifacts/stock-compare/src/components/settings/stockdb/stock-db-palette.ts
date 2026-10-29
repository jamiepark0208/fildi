// ── Coverage color helpers ─────────────────────────────────────────────────────
// Bright R/Y/G — not muted /50 washes (Jamie: prefer Fundamentals gold brightness).

export function coverageColor(pct: number): string {
  return pct < 50 ? "text-red-400" : pct < 80 ? "text-amber-300" : "text-emerald-400";
}

export function coverageBarColor(pct: number): string {
  return pct < 50 ? "bg-red-500" : pct < 80 ? "bg-amber-400" : "bg-emerald-500";
}

/** Fund family label color (column headers) — field cols use this (un-bold). */
export const FAMILY_LABEL: Record<string, string> = {
  total:   "text-[#d4af37]",
  value:   "text-sky-400",
  growth:  "text-emerald-400",
  quality: "text-violet-400",
  safety:  "text-[#d4af37]",
  meta:    "text-white",
};

/** Solid fill for family SCORE columns (headers + body tint). */
export const FAMILY_SOLID: Record<string, string> = {
  total:   "bg-[#d4af37] text-black",
  value:   "bg-sky-500 text-black",
  growth:  "bg-emerald-500 text-black",
  quality: "bg-violet-500 text-white",
  safety:  "bg-amber-400 text-black",
  meta:    "bg-zinc-500 text-white",
};

/** Body cell wash for family score columns (keeps solid-family read without drowning numbers). */
export const FAMILY_CELL_BG: Record<string, string> = {
  total:   "bg-[#d4af37]/25",
  value:   "bg-sky-500/20",
  growth:  "bg-emerald-500/20",
  quality: "bg-violet-500/20",
  safety:  "bg-amber-400/20",
  meta:    "bg-zinc-500/25",
};

/** Solid chip fill + readable text (V/G/Q/S/M pills). Safety = desk gold. */
export const FAMILY_CHIP: Record<string, string> = {
  value:   "bg-sky-600 text-white",
  growth:  "bg-emerald-600 text-white",
  quality: "bg-violet-600 text-white",
  safety:  "bg-[#d4af37] text-black",
  meta:    "bg-zinc-600 text-white",
};

// ── Sector color palettes ─────────────────────────────────────────────────────

export interface SectorPalette { bg: string; border: string; text: string; badge: string; chevron: string }

// Solid-ish bars + white text; bright badge fills (no /40 grey wash).
export const SECTOR_PALETTE: Record<string, SectorPalette> = {
  technology:    { bg: "bg-blue-900",    border: "border-l-sky-400",     text: "text-white", badge: "bg-sky-500 text-white",     chevron: "text-sky-300" },
  financial:     { bg: "bg-emerald-900", border: "border-l-emerald-400", text: "text-white", badge: "bg-emerald-500 text-white", chevron: "text-emerald-300" },
  healthcare:    { bg: "bg-violet-900",  border: "border-l-violet-400",  text: "text-white", badge: "bg-violet-500 text-white",  chevron: "text-violet-300" },
  energy:        { bg: "bg-orange-900",  border: "border-l-orange-400",  text: "text-white", badge: "bg-orange-500 text-white",  chevron: "text-orange-300" },
  consumer:      { bg: "bg-rose-900",    border: "border-l-rose-400",    text: "text-white", badge: "bg-rose-500 text-white",    chevron: "text-rose-300" },
  industrial:    { bg: "bg-cyan-900",    border: "border-l-cyan-400",    text: "text-white", badge: "bg-cyan-500 text-white",    chevron: "text-cyan-300" },
  real_estate:   { bg: "bg-yellow-900",  border: "border-l-[#d4af37]",   text: "text-white", badge: "bg-[#d4af37] text-black",  chevron: "text-[#d4af37]" },
  utilities:     { bg: "bg-teal-900",    border: "border-l-teal-400",    text: "text-white", badge: "bg-teal-500 text-white",    chevron: "text-teal-300" },
  materials:     { bg: "bg-lime-900",    border: "border-l-lime-400",    text: "text-white", badge: "bg-lime-500 text-black",    chevron: "text-lime-300" },
  communication: { bg: "bg-indigo-900",  border: "border-l-indigo-400",  text: "text-white", badge: "bg-indigo-500 text-white",  chevron: "text-indigo-300" },
};
export const DEFAULT_SECTOR_PALETTE: SectorPalette = { bg: "bg-zinc-800", border: "border-l-[#d4af37]", text: "text-white", badge: "bg-[#d4af37] text-black", chevron: "text-[#d4af37]" };

export function getSectorPalette(sectorId: string): SectorPalette {
  const k = Object.keys(SECTOR_PALETTE).find(key => sectorId.toLowerCase().includes(key));
  return k ? SECTOR_PALETTE[k] : DEFAULT_SECTOR_PALETTE;
}
