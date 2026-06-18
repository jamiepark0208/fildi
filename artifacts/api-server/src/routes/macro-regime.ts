import { Router } from "express";
import YahooFinanceClass from "yahoo-finance2";
import { logger } from "../lib/logger.js";

const yahooFinance = new YahooFinanceClass();
const router = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

export type MacroRegime = "LOW_VOL" | "BASELINE" | "ELEVATED" | "EXTREME";
export type IndexDirection = "RALLY" | "NEUTRAL" | "CRASH";

export interface MacroRegimeResult {
  vix: number | null;
  spxChange1d: number | null;
  ndxChange1d: number | null;
  rutChange1d: number | null;
  regime: MacroRegime;
  indexDirection: IndexDirection;
  error?: string;
  fetchedAt: number;
}

// ── VIX band thresholds (aligned to professional convention ~20 = dividing line) ─
const VIX_LOW      = 15;
const VIX_ELEVATED = 20;
const VIX_EXTREME  = 30;
const INDEX_MOVE_THRESHOLD = 0.01; // ±1% for RALLY/CRASH designation

function classifyRegime(vix: number | null): MacroRegime {
  if (vix === null) return "BASELINE";
  if (vix < VIX_LOW)      return "LOW_VOL";
  if (vix < VIX_ELEVATED) return "BASELINE";
  if (vix < VIX_EXTREME)  return "ELEVATED";
  return "EXTREME";
}

function classifyDirection(spxChange: number | null, ndxChange: number | null): IndexDirection {
  const ref = spxChange ?? ndxChange ?? null;
  if (ref === null) return "NEUTRAL";
  if (ref > INDEX_MOVE_THRESHOLD)  return "RALLY";
  if (ref < -INDEX_MOVE_THRESHOLD) return "CRASH";
  return "NEUTRAL";
}

// ── In-memory cache (30 min TTL) ──────────────────────────────────────────────

export let _cache: MacroRegimeResult | null = null;
export const CACHE_TTL_MS = 30 * 60 * 1000;

// ── Route ─────────────────────────────────────────────────────────────────────

router.get("/macro/regime", async (_req, res) => {
  if (_cache && Date.now() - _cache.fetchedAt < CACHE_TTL_MS) {
    return res.json(_cache);
  }

  try {
    const quotes = await (yahooFinance as any).quote(
      ["^VIX", "^GSPC", "^IXIC", "^RUT"],
      {},
      { validateResult: false },
    ) as Array<{ regularMarketPrice?: number; regularMarketChangePercent?: number }>;

    const [vixQ, spxQ, ndxQ, rutQ] = quotes;

    const vix        = vixQ?.regularMarketPrice       ?? null;
    const spxChange1d = spxQ?.regularMarketChangePercent != null
      ? spxQ.regularMarketChangePercent / 100 : null;
    const ndxChange1d = ndxQ?.regularMarketChangePercent != null
      ? ndxQ.regularMarketChangePercent / 100 : null;
    const rutChange1d = rutQ?.regularMarketChangePercent != null
      ? rutQ.regularMarketChangePercent / 100 : null;

    const regime         = classifyRegime(vix);
    const indexDirection = classifyDirection(spxChange1d, ndxChange1d);

    _cache = { vix, spxChange1d, ndxChange1d, rutChange1d, regime, indexDirection, fetchedAt: Date.now() };
    return res.json(_cache);
  } catch (err: any) {
    logger.warn({ err: String(err?.message ?? err) }, "macro-regime: fetch failed, returning baseline");
    const fallback: MacroRegimeResult = {
      vix: null, spxChange1d: null, ndxChange1d: null, rutChange1d: null,
      regime: "BASELINE", indexDirection: "NEUTRAL",
      error: "macro data unavailable",
      fetchedAt: Date.now(),
    };
    _cache = fallback;
    return res.json(fallback);
  }
});

export default router;
