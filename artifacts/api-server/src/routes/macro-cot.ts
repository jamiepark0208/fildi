import { Router, Request, Response } from "express";
import { requireAdmin } from "../middleware/requireAdmin.js";
import {
  getCOTData,
  fetchAllCOTData,
  buildSummary,
  computeZScore,
  isCotCacheStale,
} from "../lib/cot-data.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..", "..");
const CACHE_FILE = join(ROOT, "cot-cache.json");

const router = Router();

router.get("/cot/summary", async (_req: Request, res: Response) => {
  try {
    const records = await getCOTData(52);
    const summaries = buildSummary(records);
    const result = summaries.map(s => ({
      ...s,
      zScore: computeZScore(
        records[s.instrument] ?? [],
        "levMoneyNet"
      ),
    }));
    return res.json(result);
  } catch (err) {
    // graceful degradation: try stale cache
    try {
      if (existsSync(CACHE_FILE)) {
        const cached = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
        const summaries = buildSummary(cached.records);
        return res.json(summaries.map(s => ({
          ...s,
          zScore: computeZScore(cached.records[s.instrument] ?? [], "levMoneyNet"),
          stale: true,
        })));
      }
    } catch {}
    return res.status(500).json({ error: "Failed to fetch COT data" });
  }
});

router.get("/cot/history", async (req: Request, res: Response) => {
  const { instrument, weeks } = req.query;
  if (!instrument || typeof instrument !== "string") {
    return res.status(400).json({ error: "instrument required" });
  }
  const w = Math.min(parseInt(String(weeks ?? "52"), 10) || 52, 104);
  try {
    const records = await getCOTData(w);
    const history = records[instrument];
    if (!history) return res.status(404).json({ error: "Instrument not found" });
    return res.json(history);
  } catch {
    return res.status(500).json({ error: "Failed to fetch COT history" });
  }
});

router.get("/cot/instruments", async (_req: Request, res: Response) => {
  try {
    const records = await getCOTData(1);
    return res.json(Object.keys(records).map(id => {
      const r = records[id]?.[0];
      return { id, displayName: r?.displayName ?? id, dataset: r?.dataset };
    }));
  } catch {
    return res.status(500).json({ error: "Failed" });
  }
});

router.post("/cot/refresh", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const records = await fetchAllCOTData(52);
    const { writeFileSync } = await import("fs");
    writeFileSync(CACHE_FILE, JSON.stringify({ fetchedAt: Date.now(), records }));
    return res.json({ ok: true, instruments: Object.keys(records).length });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
