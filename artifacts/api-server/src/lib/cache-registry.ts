import { searchCache, compareCache, historyCache, historyCache1D, quoteCache, breakdownCache } from '../routes/stocks.js';
import { peersCache, profileCache } from '../lib/peer-resolver.js';
import { classifyCache } from './peer-classifier.js';
import { optionsCache, ivTermCache } from '../routes/options.js';
import { techRankingsCache } from '../routes/technicals.js';
import { expiryCache } from '../lib/options.js';
import { _cache as macroCache, CACHE_TTL_MS as MACRO_REGIME_TTL } from '../routes/macro-regime.js';
import { getCacheState as getBusinessCycleRegimeState, CACHE_TTL_MS as BUSINESS_CYCLE_REGIME_TTL } from '../routes/regime.js';
import { indicatorHistoryCache, sepActualsCache, sectorRotationCache, bankNewsCache } from '../routes/macro.js';
import { tickerNewsCache } from './explain-context.js';
import { livePriceCache } from './live-quote.js';
import { schwabChainCache } from './schwab-client.js';
import { trackRecordCache } from '../routes/track-record.js';
import { screenerCache, globalMoversCache } from './live-movers.js';
import { marketDataCache } from '../routes/daily-brief.js';
import { fredYieldCache } from './fair-value-snapshots.js';
import { kalshiMacroCache } from './kalshi-macro.js';
import {
  loadMacroCache, loadChartsCache,
  MACRO_DATA_TTL_MS, MACRO_CHARTS_TTL_MS,
} from './macro-data.js';
import type { MacroCharts } from './macro-data.js';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { CacheStats } from './ttl-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const ROOT       = join(__dirname, '..', '..');
const COT_CACHE_FILE = join(ROOT, 'cot-cache.json');
const COT_TTL_MS     = 168 * 3_600_000; // 1 week — CFTC data updates Fridays

const DISPLAY_NAMES: Record<string, string> = {
  search:           'Ticker Search',
  quote:            'Stock Price & Profile',
  compare:          'Stock Comparison',
  breakdown:        'Stock Analysis',
  history:          'Price History',
  'history-1d':     'Price History (Intraday)',
  options:          'Options Chain',
  'schwab-options-chain': 'Schwab Options Chain',
  'options-expiry': 'Options Calendar',
  'options-iv-term': 'Options IV Term Structure',
  'technicals-rankings': 'Technicals Rankings (put/call V2)',
  'volatility-regime': 'Volatility Regime (VIX)',
  'business-cycle-regime': 'Business Cycle Regime',
  'macro-data':     'Macro Data (FRED + Yahoo)',
  'macro-charts':   'Macro Charts (VIX/Rates/Sentiment)',
  'macro-cot':      'COT Positioning (CFTC)',
  'peer-map':       'Peer Map',
  'peer-profile':   'Peer Profile',
  'ticker-classify': 'Peer Group Classification',
  'macro-indicator-history': 'Macro Indicator History',
  'macro-sep-actuals':       'SEP Actuals',
  'macro-sector-rotation':   'Sector Rotation Heatmap',
  'macro-bank-news':         'Bank News (Google News)',
  'ticker-news':             'Ticker News (Explain AI)',
  'live-price':              'Live Price (Golden Source)',
  'live-screener':           'Live Movers (Yahoo Screener)',
  'live-movers-combined':    'Live Movers (Combined Response)',
  'daily-brief-market':      'Daily Brief Market Strip',
  'track-record':            'Model Track Record Aggregates',
  'fair-value-yields':       'Fair Value Yields (FRED AAA / 10Y)',
  'kalshi-macro':            'Kalshi Macro Odds (FOMC / CPI)',
};

const MACRO_DATA_FILE   = join(ROOT, 'macro-data.json');
const MACRO_CHARTS_FILE = join(ROOT, 'macro-charts.json');

function fileCacheHandle(path: string) {
  return { clear() { try { if (existsSync(path)) unlinkSync(path); } catch { /* ignore */ } } };
}

export const namedCachesMap: Record<string, { clear(): void; setTtl?(ms: number): void }> = {
  search:           searchCache,
  compare:          compareCache,
  history:          historyCache,
  'history-1d':     historyCache1D,
  quote:            quoteCache,
  breakdown:        breakdownCache,
  options:          optionsCache,
  'options-iv-term': ivTermCache,
  'technicals-rankings': techRankingsCache,
  'schwab-options-chain': schwabChainCache,
  'options-expiry': expiryCache,
  'peer-map':       peersCache,
  'peer-profile':   profileCache,
  'ticker-classify': classifyCache,
  'macro-indicator-history': indicatorHistoryCache,
  'macro-sep-actuals':       sepActualsCache,
  'macro-sector-rotation':   sectorRotationCache,
  'macro-bank-news':         bankNewsCache,
  'ticker-news':             tickerNewsCache,
  'live-price':              livePriceCache,
  'live-screener':           screenerCache,
  'live-movers-combined':    globalMoversCache,
  'daily-brief-market':      marketDataCache,
  'fair-value-yields':       fredYieldCache,
  'track-record':            trackRecordCache,
  'kalshi-macro':            kalshiMacroCache,
  'macro-data':     fileCacheHandle(MACRO_DATA_FILE),
  'macro-charts':   fileCacheHandle(MACRO_CHARTS_FILE),
  'macro-cot':      fileCacheHandle(COT_CACHE_FILE),
};

function fileEntry(fetchedAt: number | null, ttlMs: number, key: string, now: number) {
  if (!fetchedAt) return [];
  const expiresAt = fetchedAt + ttlMs;
  return [{ key, expiresAt, expiresInSec: Math.round(Math.max(0, expiresAt - now) / 1000) }];
}

// Chart-array fields inside MacroCharts — each fetched independently upstream, so
// each can silently die (empty array) while the parent bucket's single fetchedAt
// still reads "fresh". Surfaced as sub-entries so a dead source (e.g. put/call in
// enh/17) shows up immediately instead of requiring manual inspection. See enh/37.
const MACRO_CHARTS_FIELDS: (keyof MacroCharts)[] = [
  'vixHistory', 'fedFundsHistory', 'tenYearHistory', 'vixCurve', 'fedFundsCurve',
  'fearGreedHistory', 'hySpreadHistory', 'igSpreadHistory', 'putCallHistory',
  'putCallRatioHistory', 'gscpiHistory', 'moneyMarketHistory', 'nfciHistory',
  'copperGoldHistory', 'dxyHistory', 'fedAssetsHistory', 'tgaHistory', 'rrpHistory',
  'reservesHistory', 'netLiquidityHistory', 'sofrIorbSpreadHistory', 'moveHistory',
];

function macroChartsFieldEntries(charts: MacroCharts | null, ttlMs: number, now: number) {
  if (!charts) return [];
  const fetchedAt = new Date(charts.fetchedAt).getTime();
  const expiresAt = fetchedAt + ttlMs;
  const expiresInSec = Math.round(Math.max(0, expiresAt - now) / 1000);
  return MACRO_CHARTS_FIELDS.map(key => {
    const points = charts[key] as unknown as Array<unknown> | undefined;
    const count = Array.isArray(points) ? points.length : 0;
    const stale = count === 0;
    return {
      key,
      expiresAt: stale ? now : expiresAt,
      expiresInSec: stale ? 0 : expiresInSec,
      label: stale ? 'EMPTY' : `${count} pts`,
      stale,
    };
  });
}

// Single source of truth for pruning + stats — keeps the two in sync (profileCache
// was previously tracked in DISPLAY_NAMES but missing from both, see bugs/5).
const ttlCaches = [searchCache, compareCache, historyCache, historyCache1D, quoteCache, breakdownCache, optionsCache, ivTermCache, schwabChainCache, expiryCache, peersCache, profileCache, classifyCache, indicatorHistoryCache, sepActualsCache, sectorRotationCache, bankNewsCache, tickerNewsCache, livePriceCache, screenerCache, globalMoversCache, marketDataCache, fredYieldCache, techRankingsCache, trackRecordCache, kalshiMacroCache];

/** Non-TTLCache entries (single objects / files) have no hit counters. */
const NO_COUNTERS = { sets: 0, evictions: 0, coalesced: 0, callsSaved: 0, startedAt: 0, estBytes: null } as const;

const PRUNE_INTERVAL_MS = 10 * 60 * 1000; // 10 min — O(n) on small n, see bugs/5

export function startCacheSweep(): NodeJS.Timeout {
  return setInterval(() => {
    for (const c of ttlCaches) c.pruneExpired();
  }, PRUNE_INTERVAL_MS).unref();
}

export function getAllCaches(): CacheStats[] {
  const now = Date.now();

  const macroRegimeEntry = macroCache as { fetchedAt?: number } | null;
  const macroDataEntry   = loadMacroCache();
  const macroChartsEntry = loadChartsCache();

  let cotFetchedAt: number | null = null;
  try {
    if (existsSync(COT_CACHE_FILE)) {
      const raw = JSON.parse(readFileSync(COT_CACHE_FILE, 'utf-8')) as { fetchedAt?: number };
      cotFetchedAt = raw.fetchedAt ?? null;
    }
  } catch { /* ignore */ }

  return [
    ...ttlCaches.map(c => {
      const stats = c.getStats();
      return { ...stats, displayName: DISPLAY_NAMES[stats.name] ?? stats.name };
    }),
    {
      name: 'volatility-regime',
      displayName: DISPLAY_NAMES['volatility-regime']!,
      ttlMs: MACRO_REGIME_TTL,
      entryCount: macroRegimeEntry ? 1 : 0,
      hits: null, misses: null, hitRate: '—', ...NO_COUNTERS,
      entries: fileEntry(macroRegimeEntry?.fetchedAt ?? null, MACRO_REGIME_TTL, 'market-data', now),
    },
    {
      name: 'business-cycle-regime',
      displayName: DISPLAY_NAMES['business-cycle-regime']!,
      ttlMs: BUSINESS_CYCLE_REGIME_TTL,
      entryCount: getBusinessCycleRegimeState() ? 1 : 0,
      hits: null, misses: null, hitRate: '—', ...NO_COUNTERS,
      entries: fileEntry(getBusinessCycleRegimeState()?.cachedAt ?? null, BUSINESS_CYCLE_REGIME_TTL, 'business-cycle', now),
    },
    {
      name: 'macro-data',
      displayName: DISPLAY_NAMES['macro-data']!,
      ttlMs: MACRO_DATA_TTL_MS,
      entryCount: macroDataEntry ? 1 : 0,
      hits: null, misses: null, hitRate: '—', ...NO_COUNTERS,
      entries: fileEntry(macroDataEntry ? new Date(macroDataEntry.fetchedAt).getTime() : null, MACRO_DATA_TTL_MS, 'macro-data', now),
    },
    {
      name: 'macro-charts',
      displayName: DISPLAY_NAMES['macro-charts']!,
      ttlMs: MACRO_CHARTS_TTL_MS,
      entryCount: macroChartsEntry ? 1 : 0,
      hits: null, misses: null, hitRate: '—', ...NO_COUNTERS,
      entries: macroChartsFieldEntries(macroChartsEntry, MACRO_CHARTS_TTL_MS, now),
    },
    {
      name: 'macro-cot',
      displayName: DISPLAY_NAMES['macro-cot']!,
      ttlMs: COT_TTL_MS,
      entryCount: cotFetchedAt ? 1 : 0,
      hits: null, misses: null, hitRate: '—', ...NO_COUNTERS,
      entries: fileEntry(cotFetchedAt, COT_TTL_MS, 'cot-all-instruments', now),
    },
  ];
}
