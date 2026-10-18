import { Router } from "express";
import { liveHotlist, rallySignal, MARKET_CONTEXT_SYMBOLS, ASIA_INDEX_SYMBOLS, type HotlistEntry, type HotlistSide } from "../lib/live-hotlist.js";
import { getLivePrices, livePriceCache } from "../lib/live-quote.js";
import { getLiveIndicatorOverlay } from "../lib/indicators.js";
import { fetchGlobalMovers } from "../lib/live-movers.js";
import { buildMoverFacts, formatMoverFactLine } from "../lib/mover-facts.js";
import { getTodaysCheckpoints } from "../lib/intraday-regime.js";
import { getTodaysEntrySignals, computeEntryStats } from "../lib/intraday-entry-signals.js";
import { getPatternDigest } from "../lib/intraday-pattern-digest.js";
import { hasHighImportanceCatalystToday, isEconomicCalendarStale } from "../lib/macro-static.js";
import { TTLCache } from "../lib/ttl-cache.js";
import { fetchKalshiMacroStrip } from "../lib/kalshi-macro.js";
import { getScenarioExposure, parseScenarioId, SCENARIO_IDS, SCENARIO_LABELS } from "../lib/scenario-exposure.js";
import { and, eq, isNull } from "drizzle-orm";
import { db, watchlist, positions } from "@workspace/db";

const router = Router();

/** Book tickers for A149 — watchlist ∪ open positions. */
async function bookTickersForScenarios(userId: number | undefined): Promise<string[]> {
  const out = new Set<string>();
  if (userId == null) return [];
  try {
    const wl = await db.select({ ticker: watchlist.ticker }).from(watchlist).where(eq(watchlist.userId, userId)).limit(80);
    for (const r of wl) out.add(r.ticker.toUpperCase());
  } catch { /* ignore */ }
  try {
    const pos = await db.select({ ticker: positions.ticker }).from(positions)
      .where(and(eq(positions.userId, userId), isNull(positions.closedAt))).limit(40);
    for (const r of pos) out.add(r.ticker.toUpperCase());
  } catch { /* ignore */ }
  return [...out];
}

export interface MarketContextQuote {
  ticker: string;
  price: number | null;
  changePercent: number | null;
}

async function fetchMarketContext(): Promise<MarketContextQuote[]> {
  const live = await getLivePrices(MARKET_CONTEXT_SYMBOLS);
  return MARKET_CONTEXT_SYMBOLS.map(ticker => ({
    ticker,
    price: live.get(ticker)?.price ?? null,
    changePercent: live.get(ticker)?.changePercent ?? null,
  }));
}

// KOSPI/Nikkei/HSI close before the US session opens, so this reads as "how did
// Asia do overnight" — same golden-source quote cache as fetchMarketContext,
// just a different ticker set. Display-only: does not feed regime/entry logic.
async function fetchAsiaContext(): Promise<MarketContextQuote[]> {
  const live = await getLivePrices([...ASIA_INDEX_SYMBOLS]);
  return ASIA_INDEX_SYMBOLS.map(ticker => ({
    ticker,
    price: live.get(ticker)?.price ?? null,
    changePercent: live.get(ticker)?.changePercent ?? null,
  }));
}

/** Overlay live price + intraday-refreshed RSI/MFI/Stoch/MACD/signal onto the daily-derived hot list. */
async function liveHotlistEntries(side: HotlistSide): Promise<HotlistEntry[]> {
  const entries = liveHotlist.getEntries(side);
  if (entries.length === 0) return entries;

  const tickers = entries.map(e => e.ticker);
  const [live, indicatorOverlay] = await Promise.all([
    getLivePrices(tickers),
    getLiveIndicatorOverlay(tickers),
  ]);

  return entries.map(e => {
    const merged = {
      ...e,
      price: live.get(e.ticker)?.price ?? e.price,
      ...indicatorOverlay.get(e.ticker),
    };
    // The overlay's signal is oversold-based; recompute for the rally side from overlaid values.
    if (side === "rally") merged.signal = rallySignal(merged.rsi, merged.mfi);
    return merged;
  });
}

async function snapshot(): Promise<{
  hotlist: HotlistEntry[];
  rallyHotlist: HotlistEntry[];
  marketContext: MarketContextQuote[];
  asiaContext: MarketContextQuote[];
  hasCatalystToday: boolean;
  catalystCalendarStale: boolean;
  lastRefreshedAt: number | null;
}> {
  const [hotlist, rallyHotlist, marketContext, asiaContext] = await Promise.all([
    liveHotlistEntries("dip"),
    liveHotlistEntries("rally"),
    fetchMarketContext(),
    fetchAsiaContext(),
  ]);
  return {
    hotlist,
    rallyHotlist,
    marketContext,
    asiaContext,
    hasCatalystToday: hasHighImportanceCatalystToday(),
    catalystCalendarStale: isEconomicCalendarStale(),
    lastRefreshedAt: liveHotlist.getLastRefreshedAt(),
  };
}

// Prototype: no background refresh loop yet (see live-hotlist.ts ENABLE_AUTO_REFRESH).
// This endpoint is button-triggered from the Live tab.
router.get("/live/state", async (_req, res, next) => {
  try {
    // Never block first paint on a cold post-restart scan — warm in background.
    if (liveHotlist.getLastRefreshedAt() === null) {
      void liveHotlist.refresh();
    }
    res.json(await snapshot());
  } catch (err) {
    next(err);
  }
});

/**
 * GET /live/prices?tickers=A,B,C — golden-source live equity prices (Schwab → Yahoo,
 * 60s TTLCache). Lightweight board overlay — not a full quote/metrics fan-out.
 */
router.get("/live/prices", async (req, res, next) => {
  try {
    const raw = String(req.query["tickers"] ?? "");
    const tickers = [...new Set(raw.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean))];
    if (tickers.length === 0) {
      return res.status(400).json({ error: "tickers is required" });
    }
    if (tickers.length > 200) {
      return res.status(400).json({ error: "max 200 tickers" });
    }
    const live = await getLivePrices(tickers);
    const prices: Record<string, { price: number | null; changePercent: number | null }> = {};
    for (const t of tickers) {
      const q = live.get(t);
      prices[t] = { price: q?.price ?? null, changePercent: q?.changePercent ?? null };
    }
    return res.json({ prices });
  } catch (err) {
    return next(err);
  }
});

router.post("/live/refresh", async (_req, res, next) => {
  try {
    await liveHotlist.refresh();
    livePriceCache.clear();
    res.json(await snapshot());
  } catch (err) {
    next(err);
  }
});

router.get("/live/movers", async (_req, res, next) => {
  try {
    const global = await fetchGlobalMovers();
    // A81 facts on |move|≥5% names (display-only; no advice takes).
    const movers = [...global.gainers, ...global.losers, ...global.mostActive];
    const big = movers.filter((m) => m.changePercent != null && Math.abs(m.changePercent) >= 5);
    const facts = await buildMoverFacts(big.map((m) => m.ticker));
    const byTicker = Object.fromEntries(
      facts.map((f) => [f.ticker, { ...f, line: formatMoverFactLine(f) }]),
    );
    res.json({ global, facts: byTicker });
  } catch (err) {
    next(err);
  }
});

router.get("/live/regime", async (_req, res, next) => {
  try {
    res.json(await getTodaysCheckpoints());
  } catch (err) {
    next(err);
  }
});

// New graded rows land at most once/session (checkpoint grading is nightly/Saturday),
// so a long TTL avoids recomputing this aggregate on every Live tab load.
const patternDigestCache = new TTLCache<Awaited<ReturnType<typeof getPatternDigest>>>(6 * 60 * 60 * 1000, "pattern-digest", 4);

router.get("/live/pattern-digest", async (req, res, next) => {
  try {
    const sessionsBack = Math.min(60, Math.max(5, parseInt(String(req.query["sessions"] ?? "20"), 10) || 20));
    const data = await patternDigestCache.getOrCompute(String(sessionsBack), () => getPatternDigest(sessionsBack));
    res.json(data);
  } catch (err) {
    next(err);
  }
});

router.get("/live/entry-signals", async (_req, res, next) => {
  try {
    res.json(await getTodaysEntrySignals());
  } catch (err) {
    next(err);
  }
});

router.get("/live/entry-stats", async (_req, res, next) => {
  try {
    res.json(await computeEntryStats(30));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /live/pred-markets — A82 Kalshi FOMC + CPI odds strip (hourly cache).
 * Internal display only; personal use per Kalshi ToS.
 */
router.get("/live/pred-markets", async (_req, res, next) => {
  try {
    res.json(await fetchKalshiMacroStrip());
  } catch (err) {
    next(err);
  }
});

/**
 * GET /live/scenarios?scenario=oil — A149 scenario exposure for book names (OpenJev S039).
 */
router.get("/live/scenarios", async (req, res, next) => {
  try {
    const scenario = parseScenarioId(req.query["scenario"]) ?? "oil";
    const book = await bookTickersForScenarios(req.session?.userId);
    const data = getScenarioExposure(scenario, book);
    res.json({
      ...data,
      scenarios: SCENARIO_IDS.map((id) => ({ id, label: SCENARIO_LABELS[id] })),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
