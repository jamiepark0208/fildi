import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getAllCaches, namedCachesMap } from "../lib/cache-registry.js";
import { buildVendorHealth, readVendorHealthSnapshot } from "../lib/vendor-health.js";

const router = Router();

router.get("/admin/cache/status", requireAdmin, (_req, res) => {
  res.json({ caches: getAllCaches(), generatedAt: Date.now() });
});

/** A snapshot this fresh is served at once and re-probed behind (rule 8c): a down Yahoo made the page wait the 8 s deadline. */
const VENDOR_HEALTH_SERVE_MS = 5 * 60_000;
let vendorHealthInFlight: Promise<unknown> | null = null;

/** Settings › API Monitor — Yahoo/DNS path + circuit + last Maintain slice. */
router.get("/admin/vendor-health", requireAdmin, async (req, res) => {
  const probe = String(req.query.probe ?? "1") !== "0";
  try {
    const snap = readVendorHealthSnapshot();
    if (snap && (!probe || Date.now() - Date.parse(snap.checkedAt) < VENDOR_HEALTH_SERVE_MS)) {
      if (probe && !vendorHealthInFlight) {
        vendorHealthInFlight = buildVendorHealth({ probe }).catch(() => null).finally(() => { vendorHealthInFlight = null; });
      }
      return res.json(snap);
    }
    return res.json(await buildVendorHealth({ probe }));
  } catch (err: unknown) {
    return res.status(500).json({ error: String((err as Error)?.message ?? err) });
  }
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
