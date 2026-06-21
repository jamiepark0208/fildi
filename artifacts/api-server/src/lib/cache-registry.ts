import { searchCache, compareCache, historyCache, historyCache1D, quoteCache, breakdownCache } from '../routes/stocks.js';
import { peersCache } from '../lib/peer-resolver.js';
import { optionsCache } from '../routes/options.js';
import { expiryCache } from '../lib/options.js';
import { _cache as macroCache, CACHE_TTL_MS as MACRO_TTL } from '../routes/macro-regime.js';
import type { CacheStats } from './ttl-cache.js';

const DISPLAY_NAMES: Record<string, string> = {
  search: 'Ticker Search',
  quote: 'Stock Price & Profile',
  compare: 'Stock Comparison',
  breakdown: 'Stock Analysis',
  history: 'Price History',
  'history-1d': 'Price History (Intraday)',
  options: 'Options Chain',
  'options-expiry': 'Options Calendar',
  'macro-regime': 'Market Regime (VIX)',
  'peer-map': 'Peer Map',
  'peer-profile': 'Peer Profile',
};

export const namedCachesMap: Record<string, { clear(): void; setTtl?(ms: number): void }> = {
  search: searchCache,
  compare: compareCache,
  history: historyCache,
  'history-1d': historyCache1D,
  quote: quoteCache,
  breakdown: breakdownCache,
  options: optionsCache,
  'options-expiry': expiryCache,
  'peer-map': peersCache,
};

export function getAllCaches(): CacheStats[] {
  const now = Date.now();
  const ttlCaches = [searchCache, compareCache, historyCache, historyCache1D, quoteCache, breakdownCache, optionsCache, expiryCache, peersCache];

  const macroEntry = macroCache as { fetchedAt?: number } | null;
  const macroExpiresAt = macroEntry?.fetchedAt ? macroEntry.fetchedAt + MACRO_TTL : null;

  return [
    ...ttlCaches.map(c => {
      const stats = c.getStats();
      return { ...stats, displayName: DISPLAY_NAMES[stats.name] ?? stats.name };
    }),
    {
      name: 'macro-regime',
      displayName: 'Market Regime (VIX)',
      ttlMs: MACRO_TTL,
      entryCount: macroEntry ? 1 : 0,
      hits: null,
      misses: null,
      hitRate: '—',
      entries: macroEntry && macroExpiresAt ? [{
        key: 'market-data',
        expiresAt: macroExpiresAt,
        expiresInSec: Math.round(Math.max(0, macroExpiresAt - now) / 1000),
      }] : [],
    },
  ];
}
