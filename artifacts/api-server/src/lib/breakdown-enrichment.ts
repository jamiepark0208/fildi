/**
 * Soft / read-path enrichment for Stock Breakdown (score evidence, desk, street, trade).
 */
import { desc, eq, gte } from "drizzle-orm";
import {
  db,
  pool,
  deskCommentaries,
  tickerTechnicals,
  type TickerFundamentalsRow,
  type TickerTechnicalsRow,
} from "@workspace/db";
import { ibesRevBreadth, avgIbesSue, streetEventRisk } from "./fund-derived-metrics.js";
import { scoreTechnicalRowV2 } from "./technical-scorer-v2.js";
import { synthesizeStreet, type StreetSynthesis } from "./street-synthesis.js";
import {
  activeAdjPoints,
  ensureFundScoreAccountabilityTables,
  readFundScoreHistory,
  upsertFundScoreSnapshots,
  type HistoryPoint,
  type TopMetric,
} from "./fund-score-snapshots.js";
import { logger } from "./logger.js";

function n(v: unknown): number | null {
  if (v == null) return null;
  const x = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(x) ? x : null;
}

export type ScoreEvidence = {
  total: number | null;
  value: number | null;
  growth: number | null;
  quality: number | null;
  safety: number | null;
  company: number | null;
  sector: number | null;
  style: string | null;
  confidence: string | null;
  coverage: number | null;
  rank: number | null;
  scoredAt: string | null;
  /** When fundamentals inputs were last merged (A99 Phase 2). */
  inputsAsOf: string | null;
  peerGroupId: string | null;
  topMetrics: TopMetric[];
  modelScore: number | null;
  deskScore: number | null;
  activeAdjPoints: number;
};

export type DeskHit = {
  id: number;
  source: string;
  kind: string;
  subject: string;
  receivedAt: string;
  synopsis: string | null;
  excerpt: string | null;
  category: string | null;
};

export type TradeOverlay = {
  techScore: number | null;
  atmPutIv: number | null;
  realizedVol20d: number | null;
  ivVsRealized: number | null;
  earningsDaysOut: number | null;
  streetEventRisk: boolean;
  regime: string | null;
};

export async function buildScoreEvidence(
  ticker: string,
  row: TickerFundamentalsRow | null,
): Promise<ScoreEvidence> {
  const adj = await activeAdjPoints(ticker);
  const total = n(row?.fundTotalScore);
  const snapMeta = await latestSnapshotMeta(ticker);
  return {
    total,
    value: n(row?.fundValueScore),
    growth: n(row?.fundGrowthScore),
    quality: n(row?.fundQualityScore),
    safety: n(row?.fundSafetyScore),
    company: n(row?.fundCompanyScore),
    sector: n(row?.fundSectorScore),
    style: row?.styleBucket ?? null,
    confidence: row?.fundScoreConfidence ?? null,
    coverage: snapMeta.coverage,
    rank: row?.fundRank ?? null,
    scoredAt: row?.fundScoreComputedAt?.toISOString() ?? null,
    inputsAsOf: row?.fundamentalsLastFetched?.toISOString() ?? null,
    peerGroupId: snapMeta.peerGroupId,
    topMetrics: snapMeta.topMetrics,
    modelScore: total,
    deskScore: total != null ? Math.max(0, Math.min(100, total + adj)) : null,
    activeAdjPoints: adj,
  };
}

async function latestSnapshotMeta(ticker: string): Promise<{
  topMetrics: TopMetric[];
  coverage: number | null;
  peerGroupId: string | null;
}> {
  try {
    const r = await pool.query<{
      top_metrics: TopMetric[];
      coverage: string | number | null;
      peer_group_id: string | null;
    }>(
      `SELECT top_metrics, coverage, peer_group_id
       FROM fund_score_snapshots WHERE ticker = $1 ORDER BY as_of DESC LIMIT 1`,
      [ticker.toUpperCase()],
    );
    const row = r.rows[0];
    return {
      topMetrics: Array.isArray(row?.top_metrics) ? row!.top_metrics : [],
      coverage: n(row?.coverage),
      peerGroupId: row?.peer_group_id ?? null,
    };
  } catch {
    return { topMetrics: [], coverage: null, peerGroupId: null };
  }
}

/** Seed today's snapshot only when missing — never overwrite a scoring-run row. */
export async function ensureTodaySnapshot(ticker: string, row: TickerFundamentalsRow | null): Promise<void> {
  if (!row?.fundTotalScore) return;
  try {
    await ensureFundScoreAccountabilityTables();
    const asOf = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const existing = await pool.query(
      `SELECT 1 FROM fund_score_snapshots WHERE ticker = $1 AND as_of = $2::date LIMIT 1`,
      [ticker.toUpperCase(), asOf],
    );
    if ((existing.rowCount ?? 0) > 0) return;
    await upsertFundScoreSnapshots([
      {
        ticker,
        fundTotal: n(row.fundTotalScore),
        fundValue: n(row.fundValueScore),
        fundGrowth: n(row.fundGrowthScore),
        fundQuality: n(row.fundQualityScore),
        fundSafety: n(row.fundSafetyScore),
        styleBucket: row.styleBucket,
        coverage: null,
        confidence: row.fundScoreConfidence,
        peerGroupId: null,
        topMetrics: [],
        trigger: "manual_refresh",
      },
    ]);
  } catch (err) {
    logger.debug({ err: String(err), ticker }, "ensureTodaySnapshot skipped");
  }
}

export async function loadScoreHistory(ticker: string): Promise<HistoryPoint[]> {
  try {
    return await readFundScoreHistory(ticker, { days: 365 });
  } catch (err) {
    logger.warn({ err: String(err), ticker }, "score history unavailable");
    return [];
  }
}

export async function loadDeskHits(ticker: string, limit = 8): Promise<DeskHit[]> {
  const key = ticker.toUpperCase();
  const since = new Date();
  since.setDate(since.getDate() - 14);
  try {
    const rows = await db
      .select({
        id: deskCommentaries.id,
        source: deskCommentaries.source,
        kind: deskCommentaries.kind,
        subject: deskCommentaries.subject,
        receivedAt: deskCommentaries.receivedAt,
        synopsis: deskCommentaries.synopsis,
        bodyPlain: deskCommentaries.bodyPlain,
        category: deskCommentaries.category,
        tickersMentioned: deskCommentaries.tickersMentioned,
        meta: deskCommentaries.meta,
      })
      .from(deskCommentaries)
      .where(gte(deskCommentaries.receivedAt, since))
      .orderBy(desc(deskCommentaries.receivedAt))
      .limit(200);

    const hits: DeskHit[] = [];
    for (const r of rows) {
      const mentioned = Array.isArray(r.tickersMentioned)
        ? r.tickersMentioned.map((t) => String(t).toUpperCase())
        : [];
      if (!mentioned.includes(key)) continue;
      const meta = (r.meta && typeof r.meta === "object" ? r.meta : {}) as Record<string, unknown>;
      const digs = Array.isArray(meta.digFacts)
        ? (meta.digFacts as Array<{ text?: string }>).map((d) => d.text).filter(Boolean)
        : [];
      const excerpt =
        (digs[0] as string | undefined) ??
        (r.synopsis?.slice(0, 220) ?? null) ??
        (r.bodyPlain ? r.bodyPlain.replace(/\s+/g, " ").slice(0, 220) : null);
      hits.push({
        id: r.id,
        source: r.source,
        kind: r.kind,
        subject: r.subject,
        receivedAt: r.receivedAt.toISOString(),
        synopsis: r.synopsis,
        excerpt,
        category: r.category,
      });
      if (hits.length >= limit) break;
    }
    return hits;
  } catch (err) {
    logger.warn({ err: String(err), ticker }, "desk hits failed");
    return [];
  }
}

async function loadWrdsLight(ticker: string) {
  try {
    const idRow = await pool.query<{ ibes_oftic: string | null }>(
      `SELECT ibes_oftic FROM research_common.security_map WHERE ticker = $1`,
      [ticker],
    ).catch(() => ({ rows: [] as { ibes_oftic: string | null }[] }));
    const oftic = (idRow.rows[0]?.ibes_oftic || ticker).toUpperCase();

    const [statsum, surp] = await Promise.all([
      pool.query<{
        numup: number | null;
        numdown: number | null;
        numest: number | null;
        meanest: string | number | null;
        medest: string | number | null;
        fiscalp: string | null;
        fpi: string | null;
        statpers: string | null;
      }>(
        `SELECT numup, numdown, numest, meanest, medest, fiscalp, fpi, statpers::text
         FROM wrds_research.ibes_statsum
         WHERE oftic = $1 AND measure = 'EPS'
         ORDER BY statpers DESC
         LIMIT 24`,
        [oftic],
      ),
      pool.query<{ suescore: string | number | null }>(
        `SELECT suescore FROM wrds_research.ibes_surpsum
         WHERE oftic = $1 ORDER BY anndats DESC NULLS LAST LIMIT 8`,
        [oftic],
      ),
    ]);
    const rows = statsum.rows;
    if (rows.length === 0 && surp.rows.length === 0) {
      return { available: false as const };
    }
    const fy1 = rows.filter((r) => (r.fiscalp === "ANN" || r.fiscalp === "Y") && (r.fpi === "1" || r.fpi === "1.0"));
    const seriesSrc = fy1.length >= 2 ? fy1 : rows;
    const latest = seriesSrc[0] ?? null;
    const prior = seriesSrc[1] ?? null;
    const breadth = latest ? ibesRevBreadth(latest.numup, latest.numdown, latest.numest) : null;
    const sue = avgIbesSue(surp.rows.map((r) => n(r.suescore)));
    const meanNow = latest ? n(latest.meanest) : null;
    const meanPrev = prior ? n(prior.meanest) : null;
    const meanDriftPct =
      meanNow != null && meanPrev != null && meanPrev !== 0
        ? ((meanNow - meanPrev) / Math.abs(meanPrev)) * 100
        : null;
    return {
      available: true as const,
      breadth,
      sue,
      meanest: meanNow,
      meanDriftPct,
      streetEventRisk: streetEventRisk(breadth, sue),
    };
  } catch {
    return { available: false as const };
  }
}

async function loadLsegLight(ticker: string) {
  try {
    const r = await pool.query<{
      rec_mean: number | null;
      pt_mean: number | null;
      eps_drift_30d_pct: number | null;
      arm_rank: number | null;
      pred_surprise_pct_fq1: number | null;
      combined_alpha_rank: number | null;
    }>(
      `SELECT rec_mean, pt_mean, eps_drift_30d_pct, arm_rank, pred_surprise_pct_fq1, combined_alpha_rank
       FROM lseg_research.signals_daily
       WHERE ticker = $1
       ORDER BY as_of DESC
       LIMIT 1`,
      [ticker],
    );
    const row = r.rows[0];
    if (!row) return { available: false as const };
    return {
      available: true as const,
      recMean: n(row.rec_mean),
      targetPrice: n(row.pt_mean),
      epsDrift30dPct: n(row.eps_drift_30d_pct),
      armRank: row.arm_rank,
      predSurprisePct: n(row.pred_surprise_pct_fq1),
      combinedAlphaRank: row.combined_alpha_rank,
    };
  } catch {
    return { available: false as const };
  }
}

export async function buildStreetSynthesis(args: {
  ticker: string;
  recommendations: {
    strongBuy?: number;
    buy?: number;
    hold?: number;
    sell?: number;
    strongSell?: number;
  } | null;
  targetMean: number | null;
  price: number | null;
}): Promise<StreetSynthesis> {
  const [wrds, lseg] = await Promise.all([
    loadWrdsLight(args.ticker),
    loadLsegLight(args.ticker),
  ]);
  return synthesizeStreet({
    ticker: args.ticker,
    yahoo: args.recommendations
      ? { ...args.recommendations, targetMean: args.targetMean, price: args.price }
      : { targetMean: args.targetMean, price: args.price },
    wrds,
    lseg,
  });
}

export async function buildTradeOverlay(
  ticker: string,
  streetRisk: boolean,
): Promise<TradeOverlay> {
  try {
    const rows = await db
      .select()
      .from(tickerTechnicals)
      .where(eq(tickerTechnicals.ticker, ticker.toUpperCase()))
      .limit(1);
    const row = rows[0] as TickerTechnicalsRow | undefined;
    if (!row) {
      return {
        techScore: null,
        atmPutIv: null,
        realizedVol20d: null,
        ivVsRealized: null,
        earningsDaysOut: null,
        streetEventRisk: streetRisk,
        regime: null,
      };
    }
    return {
      techScore: scoreTechnicalRowV2(row),
      atmPutIv: n(row.atmPutIv),
      realizedVol20d: n(row.realizedVol20d),
      ivVsRealized: n(row.ivVsRealizedVol),
      earningsDaysOut: row.earningsDaysOut,
      streetEventRisk: streetRisk,
      regime: row.regime,
    };
  } catch (err) {
    logger.warn({ err: String(err), ticker }, "trade overlay failed");
    return {
      techScore: null,
      atmPutIv: null,
      realizedVol20d: null,
      ivVsRealized: null,
      earningsDaysOut: null,
      streetEventRisk: streetRisk,
      regime: null,
    };
  }
}

export async function readFundPeerGroupId(ticker: string): Promise<string | null> {
  try {
    const r = await pool.query<{ primary_peer_group_id: string | null }>(
      `SELECT primary_peer_group_id FROM ticker_registry WHERE ticker = $1`,
      [ticker.toUpperCase()],
    );
    return r.rows[0]?.primary_peer_group_id ?? null;
  } catch {
    return null;
  }
}
