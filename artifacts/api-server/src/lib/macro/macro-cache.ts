// Cache management for MacroData / MacroCharts. Extracted verbatim from
// macro-data.ts — no behavior change.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { MacroData, MacroCharts } from "../macro-data.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// This file lives in src/lib/macro/ — three levels up reaches the api-server root
// (same ROOT macro-data.ts computed from src/lib/).
const ROOT = join(__dirname, "..", "..", "..");

const CACHE_FILE        = join(ROOT, "macro-data.json");
const CHARTS_CACHE_FILE = join(ROOT, "macro-charts.json");
const SECTOR_CACHE_FILE = join(ROOT, "macro-sector-rotation.json");

/** Raw disk read — no freshness/completeness gates (used to salvage a prior good curve). */
export function readMacroCacheFile(): MacroData | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as MacroData;
  } catch {
    return null;
  }
}

export function loadMacroCache(): MacroData | null {
  try {
    const data = readMacroCacheFile();
    if (!data) return null;
    if (!data.yieldCurve || data.usDebt === undefined) return null;
    // Empty curve = poisoned cache (Treasury.gov timeout) — force refresh, don't serve blank chart for 4h.
    if (!Array.isArray(data.yieldCurve) || data.yieldCurve.length === 0) return null;
    if (!data.yieldCurve.some((p) => p?.current != null)) return null;
    // Invalidate if yield curve doesn't have new weekAgo field
    if (!("weekAgo" in data.yieldCurve[0]!)) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveMacroCache(data: MacroData): void {
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function isCacheStale(data: MacroData, ttlHours = 4): boolean {
  return Date.now() - new Date(data.fetchedAt).getTime() > ttlHours * 3_600_000;
}

export const MACRO_DATA_TTL_MS    = 4  * 3_600_000; // 4h
export const MACRO_CHARTS_TTL_MS  = 4  * 3_600_000; // 4h — daily/weekly series; refreshes intraday

/** Raw disk read — no completeness gates (salvage prior good FRED/GSCPI series). */
export function readChartsCacheFile(): MacroCharts | null {
  try {
    if (!existsSync(CHARTS_CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CHARTS_CACHE_FILE, "utf-8")) as MacroCharts;
  } catch {
    return null;
  }
}

/** FRED/NYFed series Regime/Liquidity charts need — empty used to poison the 4h cache.
 *  Yahoo series (tenYear, copperGold, vix) are soft: 429s must not block saving FRED fills. */
const CHARTS_REQUIRED_NONEMPTY: (keyof MacroCharts)[] = [
  "hySpreadHistory", "igSpreadHistory", "gscpiHistory",
  "moneyMarketHistory", "nfciHistory", "fedAssetsHistory",
];

export function chartsSeriesOk(data: MacroCharts | null | undefined): boolean {
  if (!data) return false;
  return CHARTS_REQUIRED_NONEMPTY.every((k) => {
    const v = data[k];
    return Array.isArray(v) && v.length > 0;
  });
}

export function loadChartsCache(): MacroCharts | null {
  try {
    const data = readChartsCacheFile();
    if (!data) return null;
    if (!data.vixCurve || !data.fedFundsCurve) return null;
    if (!data.hySpreadHistory || !data.putCallHistory || !data.fearGreedHistory) return null;
    if (!("putCallRatioHistory" in data) || !("gscpiHistory" in data) || !("moneyMarketHistory" in data)) return null;
    if (!("igSpreadHistory" in data) || !("nfciHistory" in data) || !("copperGoldHistory" in data) || !("dxyHistory" in data)) return null;
    if (!("netLiquidityHistory" in data) || !("fedAssetsHistory" in data) || !("tgaHistory" in data) || !("rrpHistory" in data) || !("reservesHistory" in data)) return null;
    if (!("sofrIorbSpreadHistory" in data) || !("liquidityImplications" in data)) return null;
    if (!("moveHistory" in data) || !("volatilityImplications" in data)) return null;
    // Empty FRED/NYFed series = poisoned cache (timeouts) — force refresh, don't serve "No data" for 4h.
    if (!chartsSeriesOk(data)) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveChartsCache(data: MacroCharts): void {
  writeFileSync(CHARTS_CACHE_FILE, JSON.stringify(data, null, 2), "utf-8");
}

export function isChartsCacheStale(data: MacroCharts, ttlHours = 4): boolean {
  return Date.now() - new Date(data.fetchedAt).getTime() > ttlHours * 3_600_000;
}

/** Disk cache for sector rotation (~5KB). Avoids cold Yahoo×50 on Heatmap/Liquidity open. */
export type SectorRotationDisk = { fetchedAt: string; points: unknown[] };

export function loadSectorRotationCache(): SectorRotationDisk | null {
  try {
    if (!existsSync(SECTOR_CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(SECTOR_CACHE_FILE, "utf-8")) as SectorRotationDisk;
    if (!Array.isArray(data.points) || !data.fetchedAt) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveSectorRotationCache(points: unknown[]): void {
  const payload: SectorRotationDisk = { fetchedAt: new Date().toISOString(), points };
  writeFileSync(SECTOR_CACHE_FILE, JSON.stringify(payload), "utf-8");
}

export function isSectorRotationCacheStale(data: SectorRotationDisk, ttlHours = 12): boolean {
  return Date.now() - new Date(data.fetchedAt).getTime() > ttlHours * 3_600_000;
}
