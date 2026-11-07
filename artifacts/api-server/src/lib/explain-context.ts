// Shared per-ticker context assembly for all "Explain AI" surfaces (options scanner,
// fundamental/technical score explanations, stock-breakdown, etc). Each quadrant reads
// through an existing cache rather than re-fetching — see cache-registry.ts for the
// canonical list of what backs each one.
import { readTechnicalsRow } from "./technicals-db.js";
import { resolvePeers } from "./peer-resolver.js";
import { fetchYahooTickerNews, type NewsItem } from "./macro-highlights.js";
import { sectorRotationCache } from "../routes/macro.js";
import { fetchSectorRotation, type SectorRotationPoint } from "./macro-data.js";
import { _cache as macroRegimeCache, type MacroRegime } from "../routes/macro-regime.js";
import { TTLCache } from "./ttl-cache.js";
import { logger } from "./logger.js";
import { noteLines, readStockNotes } from "./stock-notes.js";
import { themesBrief, type ThemesBrief } from "./macro/macro-themes.js";
import { gatherSourceFacts } from "./explain-source-facts.js";

export const tickerNewsCache = new TTLCache<NewsItem[]>(30 * 60 * 1000, "ticker-news", 500);

async function getCachedTickerNews(ticker: string, max = 5): Promise<NewsItem[]> {
  const key = ticker.toUpperCase();
  return tickerNewsCache.getOrCompute(key, () => fetchYahooTickerNews(ticker, max));
}

async function getSectorRotation(): Promise<SectorRotationPoint[]> {
  return sectorRotationCache.getOrCompute("sector-rotation", fetchSectorRotation) as Promise<SectorRotationPoint[]>;
}

function toNum(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export interface StockEventContext {
  priceZScore: number | null;   // (price - 20d mean) / 20d stddev — outlier framing
  recentNews: { title: string; source: string; publishedAt: string }[]; // top 3
}

export interface MarketEventContext {
  volRegime: MacroRegime | null;
  /** Macro › Key Themes brief (tested market state + active playbook + theme leans). */
  keyThemes?: ThemesBrief | null;
  sector: {
    label: string;
    quadrant: SectorRotationPoint["quadrant"];
    rs1m: number | null;
    rs1w: number | null;
  } | null;
}

export interface ContextBundle {
  ticker: string;
  stockEvent: StockEventContext | null;
  marketEvent: MarketEventContext | null;
  /** Dated desk notes on this ticker (newest first) — past context, not a forecast. */
  notes?: string[];
  /** Synthesized source lines (A356) — always filled when assembleContext runs. */
  sourceFacts?: string[];
}

export type ContextQuadrant = "stockEvent" | "marketEvent";

export async function assembleContext(
  ticker: string,
  opts: { include: ContextQuadrant[] },
): Promise<ContextBundle> {
  const upper = ticker.toUpperCase();
  const bundle: ContextBundle = { ticker: upper, stockEvent: null, marketEvent: null };

  const tasks: Promise<void>[] = [];
  tasks.push(readStockNotes(upper).then(n => { bundle.notes = noteLines(n); }).catch(err => {
    logger.warn({ ticker: upper, err: String(err) }, "explain-context: stock notes failed");
  }));
  tasks.push(gatherSourceFacts(upper).then(f => { bundle.sourceFacts = f; }).catch(err => {
    logger.warn({ ticker: upper, err: String(err) }, "explain-context: source facts failed");
    bundle.sourceFacts = [];
  }));

  if (opts.include.includes("stockEvent")) {
    tasks.push((async () => {
      const [techRow, news] = await Promise.all([
        readTechnicalsRow(upper).catch(err => {
          logger.warn({ ticker: upper, err: String(err) }, "explain-context: technicals lookup failed");
          return null;
        }),
        getCachedTickerNews(upper, 5).catch(err => {
          logger.warn({ ticker: upper, err: String(err) }, "explain-context: ticker news failed");
          return [] as NewsItem[];
        }),
      ]);
      bundle.stockEvent = {
        priceZScore: techRow ? toNum(techRow.priceZScore) : null,
        recentNews: news.slice(0, 3).map(n => ({ title: n.title, source: n.source, publishedAt: n.publishedAt })),
      };
    })());
  }

  if (opts.include.includes("marketEvent")) {
    tasks.push((async () => {
      const [peers, sectorRotation, keyThemes] = await Promise.all([
        resolvePeers(upper).catch(err => {
          logger.warn({ ticker: upper, err: String(err) }, "explain-context: resolvePeers failed");
          return { ticker: upper, sector: null, industry: null, peers: [] as string[] };
        }),
        getSectorRotation().catch(err => {
          logger.warn({ err: String(err) }, "explain-context: sector rotation failed");
          return [] as SectorRotationPoint[];
        }),
        themesBrief().catch(err => {
          logger.warn({ err: String(err) }, "explain-context: key themes failed");
          return null;
        }),
      ]);
      const match = sectorRotation.find(s => s.label === peers.industry) ??
        sectorRotation.find(s => s.label === peers.sector) ?? null;
      bundle.marketEvent = {
        volRegime: macroRegimeCache?.regime ?? null,
        keyThemes,
        sector: match ? { label: match.label, quadrant: match.quadrant, rs1m: match.rs1m, rs1w: match.rs1w } : null,
      };
    })());
  }

  await Promise.all(tasks);
  return bundle;
}
