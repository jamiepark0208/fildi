import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getAllCaches, namedCachesMap } from "../lib/cache-registry.js";

const router = Router();

router.get("/admin/cache/status", requireAdmin, (_req, res) => {
  res.json({ caches: getAllCaches(), generatedAt: Date.now() });
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
