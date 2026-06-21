import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { requireAuth } from "../middleware/requireAuth.js";
import { getAllCaches, namedCachesMap } from "../lib/cache-registry.js";

const router = Router();

router.get("/admin/cache/status", requireAuth, (_req, res) => {
  res.json({ caches: getAllCaches(), generatedAt: Date.now() });
});

const ALLOWED_TTLS_MS = new Set([5, 15, 30, 60, 240, 720, 1440].map(m => m * 60_000));

router.patch("/admin/cache/ttl/:name", requireAdmin, (req, res) => {
  const name = req.params['name'] as string;
  const ttlMs = Number(req.body?.ttlMs);
  if (!ALLOWED_TTLS_MS.has(ttlMs)) return res.status(400).json({ error: 'Invalid TTL value' });
  const cache = namedCachesMap[name];
  if (!cache) return res.status(400).json({ error: 'Unknown cache' });
  if (!cache.setTtl) return res.status(400).json({ error: 'Cache does not support TTL changes' });
  cache.setTtl(ttlMs);
  return res.json({ name, ttlMs, ok: true });
});

router.delete("/admin/cache/clear/:name", requireAdmin, (req, res) => {
  const name = req.params['name'] as string;
  const cache = namedCachesMap[name];
  if (!cache) {
    return res.status(400).json({ error: 'Unknown cache' });
  }
  cache.clear();
  return res.json({ cleared: name, ok: true });
});

export default router;
