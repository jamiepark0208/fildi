import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { searchCache, compareCache, historyCache, historyCache1D, quoteCache, breakdownCache } from "./stocks.js";
import { optionsCache } from "./options.js";
import { expiryCache } from "../lib/options.js";
import { _cache as macroCacheValue, CACHE_TTL_MS as MACRO_TTL } from "./macro-regime.js";

const router = Router();

const namedCaches: Record<string, { clear(): void; getStats(): object }> = {
  search: searchCache,
  compare: compareCache,
  history: historyCache,
  'history-1d': historyCache1D,
  quote: quoteCache,
  breakdown: breakdownCache,
  options: optionsCache,
  'options-expiry': expiryCache,
};

router.get("/admin/cache/status", requireAdmin, (_req, res) => {
  const now = Date.now();
  const macroEntry = (macroCacheValue as { fetchedAt?: number } | null);
  const macroExpiresAt = macroEntry?.fetchedAt ? macroEntry.fetchedAt + MACRO_TTL : null;

  const caches = [
    ...Object.values(namedCaches).map(c => (c as { getStats(): object }).getStats()),
    {
      name: 'macro-regime',
      ttlMs: MACRO_TTL,
      entryCount: macroEntry ? 1 : 0,
      hits: null,
      misses: null,
      hitRate: '—',
      entries: macroEntry && macroExpiresAt ? [{
        key: 'macro',
        expiresAt: macroExpiresAt,
        expiresInSec: Math.round(Math.max(0, macroExpiresAt - now) / 1000),
      }] : [],
    },
  ];

  res.json({ caches, generatedAt: now });
});

router.delete("/admin/cache/clear/:name", requireAdmin, (req, res) => {
  const name = req.params['name'] as string;
  const cache = namedCaches[name];
  if (!cache) {
    return res.status(400).json({ error: 'Unknown cache' });
  }
  cache.clear();
  return res.json({ cleared: name, ok: true });
});

export default router;
