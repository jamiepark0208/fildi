import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { computeRegime, type RegimeResult } from "../lib/regime-classifier.js";
import { logger } from "../lib/logger.js";

const router = Router();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

let _cache: (RegimeResult & { cachedAt: number }) | null = null;

function isFresh(): boolean {
  return _cache !== null && Date.now() - _cache.cachedAt < CACHE_TTL_MS;
}

router.get("/regime/macro", (_req, res) => {
  if (isFresh()) return res.json(_cache);
  try {
    const result = computeRegime();
    _cache = { ...result, cachedAt: Date.now() };
    return res.json(_cache);
  } catch (err: unknown) {
    logger.error({ err: String(err) }, "regime/macro: computeRegime failed");
    return res.status(500).json({ error: "regime computation failed" });
  }
});

router.post("/regime/macro/refresh", requireAdmin, (_req, res) => {
  try {
    const result = computeRegime();
    _cache = { ...result, cachedAt: Date.now() };
    return res.json(_cache);
  } catch (err: unknown) {
    logger.error({ err: String(err) }, "regime/macro/refresh: computeRegime failed");
    return res.status(500).json({ error: "regime computation failed" });
  }
});

export default router;
