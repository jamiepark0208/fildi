/**
 * Macro › Key Themes (Jamie 10-28).
 * GET /api/macro/themes              → themes + live signposts + scenarios + unified read (lib/macro/macro-themes.ts)
 * GET /api/macro/money-flows?w=1m    → market-cap flows (sector / group / basket / players), AI money web, government flows
 * Both read caches/tables other tabs already fill; no vendor calls. 15-min TTL.
 */
import { Router, type Request, type Response } from "express";
import { TTLCache } from "../lib/ttl-cache.js";
import { buildThemes, loadCapPanel, type CapPanel } from "../lib/macro/macro-themes.js";
import { buildMoneyFlows } from "../lib/macro/money-flows.js";

const router = Router();
export const capPanelCache = new TTLCache<CapPanel | null>(15 * 60_000, "macro-cap-panel", 1);
export const themesCache = new TTLCache<object | null>(15 * 60_000, "macro-themes", 1);
export const moneyFlowsCache = new TTLCache<object>(15 * 60_000, "macro-money-flows", 3);

const caps = () => capPanelCache.getOrCompute("panel", loadCapPanel);

router.get("/themes", async (_req: Request, res: Response) => {
  try {
    const body = await themesCache.getOrCompute("themes", async () => buildThemes(await caps()));
    if (!body) return res.status(404).json({ error: "research/market-views/themes.json missing" });
    return res.json(body);
  } catch (err) {
    console.error("[macro-themes] themes failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

router.get("/money-flows", async (req: Request, res: Response) => {
  const w = (["1w", "1m", "3m"] as const).find((x) => x === req.query.w) ?? "1m";
  try {
    return res.json(await moneyFlowsCache.getOrCompute(w, async () => buildMoneyFlows(await caps(), w)));
  } catch (err) {
    console.error("[macro-themes] money-flows failed:", err);
    return res.status(500).json({ error: String(err) });
  }
});

export default router;
