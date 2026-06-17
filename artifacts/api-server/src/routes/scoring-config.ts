import { Router } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { getScoringConfigValue, upsertScoringConfigValue, deleteScoringConfigValue } from "../lib/scoring-config-db.js";
import { logger } from "../lib/logger.js";

const router = Router();

type FamilyPreset = { value: number; growth: number; quality: number; safety: number };

type ScoringWeightsPayload = {
  familyPreset?: FamilyPreset;
  fundamentalMetrics?: Record<string, number>;
  technical?: Record<string, number>;
  optionStock?: Record<string, number>;
  optionStrike?: Record<string, number>;
};

function sumValues(o: Record<string, number>): number {
  return Object.values(o).reduce((a, b) => a + b, 0);
}

function validatePartial(p: ScoringWeightsPayload): string | null {
  if (p.familyPreset) {
    const s = p.familyPreset.value + p.familyPreset.growth + p.familyPreset.quality + p.familyPreset.safety;
    if (Math.abs(s - 100) > 0.01) return `Family weights must sum to 100 (got ${s})`;
  }
  for (const [label, obj] of [
    ["Technical", p.technical],
    ["Option stock", p.optionStock],
    ["Option strike", p.optionStrike],
  ] as const) {
    if (obj) {
      const s = sumValues(obj);
      if (Math.abs(s - 1) > 0.01) return `${label} weights must sum to 1.0 (got ${s.toFixed(3)})`;
    }
  }
  return null;
}

// GET /api/scoring-config — public read (returns stored overrides or null)
router.get("/api/scoring-config", async (_req, res) => {
  try {
    const value = await getScoringConfigValue();
    res.json({ weights: value });
  } catch (err) {
    logger.error({ err }, "GET /api/scoring-config failed");
    res.status(500).json({ error: "Failed to load scoring config" });
  }
});

// PUT /api/scoring-config — admin only
router.put("/api/scoring-config", requireAdmin, async (req, res) => {
  const body = req.body as { weights?: ScoringWeightsPayload | null };
  if (body.weights === null) {
    try {
      await deleteScoringConfigValue();
      return res.json({ ok: true, weights: null });
    } catch (err) {
      logger.error({ err }, "PUT /api/scoring-config reset failed");
      return res.status(500).json({ error: "Failed to reset scoring config" });
    }
  }

  const weights = body.weights;
  if (!weights || typeof weights !== "object") {
    return res.status(400).json({ error: "weights object required" });
  }

  const err = validatePartial(weights);
  if (err) return res.status(400).json({ error: err });

  try {
    await upsertScoringConfigValue(weights);
    return res.json({ ok: true, weights });
  } catch (e) {
    logger.error({ err: e }, "PUT /api/scoring-config failed");
    return res.status(500).json({ error: "Failed to save scoring config" });
  }
});

export default router;
