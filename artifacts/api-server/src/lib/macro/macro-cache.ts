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

export function loadMacroCache(): MacroData | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw  = readFileSync(CACHE_FILE, "utf-8");
    const data = JSON.parse(raw) as MacroData;
    if (!data.yieldCurve || data.usDebt === undefined) return null;
    // Invalidate if yield curve doesn't have new weekAgo field
    if (data.yieldCurve.length > 0 && !("weekAgo" in data.yieldCurve[0])) return null;
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

export function loadChartsCache(): MacroCharts | null {
  try {
    if (!existsSync(CHARTS_CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CHARTS_CACHE_FILE, "utf-8")) as MacroCharts;
    if (!data.vixCurve || !data.fedFundsCurve) return null;
    if (!data.hySpreadHistory || !data.putCallHistory || !data.fearGreedHistory) return null;
    if (!("putCallRatioHistory" in data) || !("gscpiHistory" in data) || !("moneyMarketHistory" in data)) return null;
    if (!("igSpreadHistory" in data) || !("nfciHistory" in data) || !("copperGoldHistory" in data) || !("dxyHistory" in data)) return null;
    if (!("netLiquidityHistory" in data) || !("fedAssetsHistory" in data) || !("tgaHistory" in data) || !("rrpHistory" in data) || !("reservesHistory" in data)) return null;
    if (!("sofrIorbSpreadHistory" in data) || !("liquidityImplications" in data)) return null;
    if (!("moveHistory" in data) || !("volatilityImplications" in data)) return null;
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
