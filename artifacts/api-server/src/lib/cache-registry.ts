import { searchCache, compareCache, historyCache, historyCache1D, quoteCache, breakdownCache } from '../routes/stocks.js';
import { peersCache } from '../lib/peer-resolver.js';
import { optionsCache } from '../routes/options.js';
import { expiryCache } from '../lib/options.js';
import { _cache as macroCache, CACHE_TTL_MS as MACRO_REGIME_TTL } from '../routes/macro-regime.js';
import {
  loadMacroCache, loadChartsCache,
  MACRO_DATA_TTL_MS, MACRO_CHARTS_TTL_MS,
} from './macro-data.js';
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
  'options-expiry': 'Options Calendar',
  'macro-regime':   'Market Regime (VIX)',
  'macro-data':     'Macro Data (FRED + Yahoo)',
  'macro-charts':   'Macro Charts (VIX/Rates/Sentiment)',
  'macro-cot':      'COT Positioning (CFTC)',
  'peer-map':       'Peer Map',
  'peer-profile':   'Peer Profile',
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
  'options-expiry': expiryCache,
  'peer-map':       peersCache,
  'macro-data':     fileCacheHandle(MACRO_DATA_FILE),
  'macro-charts':   fileCacheHandle(MACRO_CHARTS_FILE),
  'macro-cot':      fileCacheHandle(COT_CACHE_FILE),
};

function fileEntry(fetchedAt: number | null, ttlMs: number, key: string, now: number) {
  if (!fetchedAt) return [];
  const expiresAt = fetchedAt + ttlMs;
  return [{ key, expiresAt, expiresInSec: Math.round(Math.max(0, expiresAt - now) / 1000) }];
}

export function getAllCaches(): CacheStats[] {
  const now = Date.now();
  const ttlCaches = [searchCache, compareCache, historyCache, historyCache1D, quoteCache, breakdownCache, optionsCache, expiryCache, peersCache];

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
      name: 'macro-regime',
      displayName: DISPLAY_NAMES['macro-regime']!,
      ttlMs: MACRO_REGIME_TTL,
      entryCount: macroRegimeEntry ? 1 : 0,
      hits: null, misses: null, hitRate: '—',
      entries: fileEntry(macroRegimeEntry?.fetchedAt ?? null, MACRO_REGIME_TTL, 'market-data', now),
    },
    {
      name: 'macro-data',
      displayName: DISPLAY_NAMES['macro-data']!,
      ttlMs: MACRO_DATA_TTL_MS,
      entryCount: macroDataEntry ? 1 : 0,
      hits: null, misses: null, hitRate: '—',
      entries: fileEntry(macroDataEntry ? new Date(macroDataEntry.fetchedAt).getTime() : null, MACRO_DATA_TTL_MS, 'macro-data', now),
    },
    {
      name: 'macro-charts',
      displayName: DISPLAY_NAMES['macro-charts']!,
      ttlMs: MACRO_CHARTS_TTL_MS,
      entryCount: macroChartsEntry ? 1 : 0,
      hits: null, misses: null, hitRate: '—',
      entries: fileEntry(macroChartsEntry ? new Date(macroChartsEntry.fetchedAt).getTime() : null, MACRO_CHARTS_TTL_MS, 'macro-charts', now),
    },
    {
      name: 'macro-cot',
      displayName: DISPLAY_NAMES['macro-cot']!,
      ttlMs: COT_TTL_MS,
      entryCount: cotFetchedAt ? 1 : 0,
      hits: null, misses: null, hitRate: '—',
      entries: fileEntry(cotFetchedAt, COT_TTL_MS, 'cot-all-instruments', now),
    },
  ];
}
