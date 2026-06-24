import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..");

const TFF_URL = "https://publicreporting.cftc.gov/resource/gpe5-46if.json";
const LEGACY_URL = "https://publicreporting.cftc.gov/resource/6dca-aqww.json";
const CACHE_FILE = join(ROOT, "cot-cache.json");
const TTL_MS = 168 * 60 * 60 * 1000; // 1 week — data only updates weekly

export interface COTRecord {
  date: string;
  instrument: string;
  displayName: string;
  dataset: "tff" | "legacy";
  openInterest: number;
  // Leveraged Money (hedge funds)
  levMoneyLong: number;
  levMoneyShort: number;
  levMoneyNet: number;
  levMoneyLongChg: number;
  levMoneyShortChg: number;
  // Asset Manager (institutions)
  assetMgrLong: number;
  assetMgrShort: number;
  assetMgrNet: number;
  assetMgrLongChg: number;
  assetMgrShortChg: number;
  // Dealer
  dealerLong: number;
  dealerShort: number;
  dealerNet: number;
}

export interface COTSummary {
  instrument: string;
  displayName: string;
  dataset: "tff" | "legacy";
  latest: COTRecord;
  history: COTRecord[]; // last 8 weeks for sparkline
}

interface CotCache {
  fetchedAt: number;
  records: Record<string, COTRecord[]>; // keyed by instrument id
}

// Instruments to track — market_and_exchange_names search terms
const TFF_INSTRUMENTS: { id: string; displayName: string; searchTerm: string }[] = [
  { id: "sp500",   displayName: "S&P 500",        searchTerm: "S&P 500 Consolidated" },
  { id: "nasdaq",  displayName: "NASDAQ-100",      searchTerm: "NASDAQ-100 Consolidated" },
  { id: "bitcoin", displayName: "Bitcoin",         searchTerm: "BITCOIN - CHICAGO MERCANTILE EXCHANGE" },
  { id: "gbp",     displayName: "GBP/USD",         searchTerm: "BRITISH POUND" },
  { id: "aud",     displayName: "AUD/USD",         searchTerm: "AUSTRALIAN DOLLAR" },
  { id: "cad",     displayName: "CAD/USD",         searchTerm: "CANADIAN DOLLAR" },
  { id: "tbonds",  displayName: "T-Bonds",         searchTerm: "UST BOND - CHICAGO BOARD OF TRADE" },
];

const LEGACY_INSTRUMENTS: { id: string; displayName: string; searchTerm: string }[] = [
  { id: "gold",  displayName: "Gold",      searchTerm: "GOLD - COMMODITY EXCHANGE INC" },
  { id: "oil",   displayName: "Crude Oil", searchTerm: "CRUDE OIL, LIGHT SWEET - NEW YORK MERCANTILE EXCHANGE" },
];

function n(v: unknown): number {
  const x = parseFloat(String(v ?? "0"));
  return isNaN(x) ? 0 : x;
}

function parseTFF(raw: Record<string, unknown>, id: string, displayName: string): COTRecord {
  const levL = n(raw.lev_money_positions_long);
  const levS = n(raw.lev_money_positions_short);
  const asmL = n(raw.asset_mgr_positions_long);
  const asmS = n(raw.asset_mgr_positions_short);
  const dlrL = n(raw.dealer_positions_long_all);
  const dlrS = n(raw.dealer_positions_short_all);
  return {
    date: String(raw.report_date_as_yyyy_mm_dd ?? "").slice(0, 10),
    instrument: id,
    displayName,
    dataset: "tff",
    openInterest: n(raw.open_interest_all),
    levMoneyLong: levL,
    levMoneyShort: levS,
    levMoneyNet: levL - levS,
    levMoneyLongChg: n(raw.change_in_lev_money_long),
    levMoneyShortChg: n(raw.change_in_lev_money_short),
    assetMgrLong: asmL,
    assetMgrShort: asmS,
    assetMgrNet: asmL - asmS,
    assetMgrLongChg: n(raw.change_in_asset_mgr_long),
    assetMgrShortChg: n(raw.change_in_asset_mgr_short),
    dealerLong: dlrL,
    dealerShort: dlrS,
    dealerNet: dlrL - dlrS,
  };
}

function parseLegacy(raw: Record<string, unknown>, id: string, displayName: string): COTRecord {
  const levL = n(raw.noncomm_positions_long_all);
  const levS = n(raw.noncomm_positions_short_all);
  const asmL = n(raw.comm_positions_long_all);
  const asmS = n(raw.comm_positions_short_all);
  const dlrL = n(raw.tot_rept_positions_long_all);
  const dlrS = n(raw.tot_rept_positions_short_all);
  return {
    date: String(raw.report_date_as_yyyy_mm_dd ?? "").slice(0, 10),
    instrument: id,
    displayName,
    dataset: "legacy",
    openInterest: n(raw.open_interest_all),
    levMoneyLong: levL,
    levMoneyShort: levS,
    levMoneyNet: levL - levS,
    levMoneyLongChg: n(raw.change_in_noncomm_long_all),
    levMoneyShortChg: n(raw.change_in_noncomm_short_all),
    assetMgrLong: asmL,
    assetMgrShort: asmS,
    assetMgrNet: asmL - asmS,
    assetMgrLongChg: n(raw.change_in_comm_long_all),
    assetMgrShortChg: n(raw.change_in_comm_short_all),
    dealerLong: dlrL,
    dealerShort: dlrS,
    dealerNet: dlrL - dlrS,
  };
}

async function fetchInstrumentHistory(
  url: string,
  searchTerm: string,
  weeks: number
): Promise<Record<string, unknown>[]> {
  const encoded = encodeURIComponent(`market_and_exchange_names like '%${searchTerm}%'`);
  const endpoint = `${url}?$where=${encoded}&$order=report_date_as_yyyy_mm_dd DESC&$limit=${weeks}`;
  const res = await fetch(endpoint);
  if (!res.ok) throw new Error(`CFTC fetch failed: ${res.status}`);
  return res.json() as Promise<Record<string, unknown>[]>;
}

function loadCache(): CotCache | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
  } catch { return null; }
}

function saveCache(cache: CotCache) {
  try { writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch {}
}

export function isCotCacheStale(cache: CotCache): boolean {
  return Date.now() - cache.fetchedAt > TTL_MS;
}

export async function fetchAllCOTData(weeks = 52): Promise<Record<string, COTRecord[]>> {
  const records: Record<string, COTRecord[]> = {};

  await Promise.all([
    ...TFF_INSTRUMENTS.map(async inst => {
      const raw = await fetchInstrumentHistory(TFF_URL, inst.searchTerm, weeks);
      records[inst.id] = raw
        .map(r => parseTFF(r, inst.id, inst.displayName))
        .sort((a, b) => a.date.localeCompare(b.date));
    }),
    ...LEGACY_INSTRUMENTS.map(async inst => {
      const raw = await fetchInstrumentHistory(LEGACY_URL, inst.searchTerm, weeks);
      records[inst.id] = raw
        .map(r => parseLegacy(r, inst.id, inst.displayName))
        .sort((a, b) => a.date.localeCompare(b.date));
    }),
  ]);

  return records;
}

export async function getCOTData(weeks = 52): Promise<Record<string, COTRecord[]>> {
  const cached = loadCache();
  if (cached && !isCotCacheStale(cached)) return cached.records;
  const records = await fetchAllCOTData(weeks);
  saveCache({ fetchedAt: Date.now(), records });
  return records;
}

export function buildSummary(records: Record<string, COTRecord[]>): COTSummary[] {
  const allInstruments = [...TFF_INSTRUMENTS, ...LEGACY_INSTRUMENTS];
  return allInstruments.flatMap(inst => {
    const history = records[inst.id] ?? [];
    if (history.length === 0) return [];
    const latest = history[history.length - 1];
    return [{
      instrument: inst.id,
      displayName: inst.displayName,
      dataset: history[0].dataset,
      latest,
      history: history.slice(-8),
    }];
  });
}

// Z-score of current net vs 52-week history
export function computeZScore(history: COTRecord[], field: "levMoneyNet" | "assetMgrNet"): number {
  if (history.length < 4) return 0;
  const vals = history.map(r => r[field]);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const std = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  if (std === 0) return 0;
  return (vals[vals.length - 1] - mean) / std;
}
