/**
 * Nightly Overall options rankings: premium-rich DB filter ∪ watchlist → chains →
 * pickBestStrike → persist option_score_snapshots.
 * Watchlist Rankings seeds from these snapshots — every watchlist ticker with
 * technicals must be attempted (not only premium-IV Overall candidates).
 */
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db, optionScoreSnapshots, type InsertOptionScoreSnapshot,
} from "@workspace/db";
import {
  pickBestStrike, selectPremiumCandidates,
  isViablePremiumIncome, CALL_STRIKE_WEIGHTS, CALL_INCOME_FLOOR, INCOME_FLOOR,
  applyPolicy,
  collectSideIVsFromChainMap, RELAXED_COMPONENT, isRelaxedComponentScores,
  type StockContext, type TechnicalRow, type MacroRegime,
} from "@workspace/option-scoring";
import { type OptionsChainResult, type OptionRow } from "./options.js";
import { fetchChainsForTickers } from "./options-chain-batch.js";
import { persistChainHistory } from "./option-chain-history.js";
import { getAllTechnicalsRows } from "./technicals-db.js";
import { readPersistedScores, computeAndPersistFundamentalScores } from "./fundamentals-db.js";
import { getMacroRegimeResult } from "../routes/macro-regime.js";
import { getLatestRegime } from "../routes/regime.js";
import { getTiltState, getCalibrationTable } from "./model-track-record.js";
import { getUnionWatchlistTickers } from "./watchlist-tickers.js";
import { loadVolumeNodes, loadIvRanks, loadShadowInputs, putTechScores, laneTechScores } from "./put-scoring-inputs.js";
import { loadPutEdgeFactors } from "./put-edge-factors.js";
import { scoreShadowOnChosenStrike } from "./option-score-shadow.js";
import { logger } from "./logger.js";
import { etDateKey } from "./market-hours.js";

const CHAIN_CONCURRENCY = 3;
/** Cap chain fetches per run — wide IV filter, not GO/WATCH. 200 → 450 (Jamie 10-20): 558 names have IV, the cap left the
 *  Model List ~130 put candidates. Chains go through the shared 100-rpm Schwab token bucket (~5 min at the noon run). */
const CANDIDATE_LIMIT = 450;

function todayStr(): string {
  return etDateKey(); // ET market date (was UTC: rolled to tomorrow after 5 PM PT, 10-20)
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

function spotOtm(spot: number, strike: number, isCall: boolean): number {
  if (!(spot > 0)) return 0;
  return isCall ? (strike - spot) / spot : (spot - strike) / spot;
}

export interface OptionRankingRow {
  ticker: string;
  side: "put" | "call";
  asOf: string;
  strike: number;
  expiry: string;
  spot: number;
  premium: number;
  weeklyIncomePct: number | null;
  otmPct: number | null;
  delta: number | null;
  strikeIv: number | null;
  dte: number | null;
  optionScore: number;
  componentScores: Record<string, unknown>;
  earningsDaysOut: number | null;
  earningsRisk: boolean;
  bidIsLive: boolean;
  quoteStale: boolean;
  dataQuality: number | null;
  atmPutIv: number | null;
  ivVsRealized: number | null;
  computedAt: string;
  rank: number;
  /** S059 put edge (puts only): simulated weekly pnl/breach quintile from watchlist_sync.put_edge_daily. */
  edge?: { quintile: number; pnlBp: number | null; breach: number | null; ivRv: number | null } | null;
  /** Focus view (Jamie 10-19 "too many tickers"): puts = put-edge Q4–Q5, top FOCUS_PUTS; calls = shares you hold, top FOCUS_CALLS. */
  focus?: boolean;
  /** A256: watchlist second-pass (relaxed income/SQ) — not a strict Overall hit. */
  relaxed?: boolean;
}

const FOCUS_PUTS = 15;
const FOCUS_CALLS = 10;

export async function readLatestOptionRankings(side: "put" | "call"): Promise<{
  rows: OptionRankingRow[];
  asOf: string | null;
  computedAt: string | null;
}> {
  // Prefer the most recent as_of that has a non-trivial board (≥20 rows). A partial
  // gap-fill for "today" must not hide yesterday's full nightly snapshot.
  const MIN_BOARD = 20;
  const dated = await db
    .select({
      asOf: optionScoreSnapshots.asOf,
      n: sql<number>`count(*)::int`,
    })
    .from(optionScoreSnapshots)
    .where(eq(optionScoreSnapshots.side, side))
    .groupBy(optionScoreSnapshots.asOf)
    .orderBy(desc(optionScoreSnapshots.asOf));

  const latest =
    dated.find((d) => Number(d.n) >= MIN_BOARD) ??
    dated[0];

  if (!latest?.asOf) return { rows: [], asOf: null, computedAt: null };

  const raw = await db
    .select()
    .from(optionScoreSnapshots)
    .where(and(
      eq(optionScoreSnapshots.side, side),
      eq(optionScoreSnapshots.asOf, latest.asOf),
    ))
    .orderBy(desc(optionScoreSnapshots.optionScore));

  const rows: OptionRankingRow[] = raw.map((r, i) => ({
    ticker: r.ticker,
    side: r.side as "put" | "call",
    asOf: String(r.asOf),
    strike: Number(r.strike),
    expiry: String(r.expiry),
    spot: Number(r.spot),
    premium: Number(r.premium),
    weeklyIncomePct: num(r.weeklyIncomePct),
    otmPct: num(r.otmPct),
    delta: num(r.delta),
    strikeIv: num(r.strikeIv),
    dte: num(r.dte),
    optionScore: Number(r.optionScore),
    componentScores: (r.componentScores ?? {}) as Record<string, unknown>,
    earningsDaysOut: r.earningsDaysOut ?? null,
    earningsRisk: r.earningsRisk,
    bidIsLive: r.bidIsLive,
    quoteStale: r.quoteStale,
    dataQuality: num(r.dataQuality),
    atmPutIv: num(r.atmPutIv),
    ivVsRealized: num(r.ivVsRealized),
    computedAt: r.computedAt instanceof Date ? r.computedAt.toISOString() : String(r.computedAt),
    rank: i + 1,
    relaxed: isRelaxedComponentScores((r.componentScores ?? {}) as Record<string, unknown>),
  }));

  await attachFocus(rows, side);
  return {
    rows,
    asOf: String(latest.asOf),
    computedAt: rows[0]?.computedAt ?? null,
  };
}

/** Puts: S059 put edge (≤ 7 days old) → `edge`; focus = Q4–Q5 by quintile then option score. Calls: S061 found covered calls lose vs
 *  holding in a rising tape, so focus = names you hold only. Missing edge coverage uses non-trim score order;
 *  failed eligibility queries leave the board visible with no Focus picks. */
async function attachFocus(rows: OptionRankingRow[], side: "put" | "call"): Promise<void> {
  try {
    if (side === "put") {
      // never focus a put on a name the Model List says to trim (same rule as build_plan not_on_trim, 10-19 ONDS)
      const { rows: tr } = await db.execute(sql`SELECT ticker FROM watchlist_sync.plan_items
        WHERE plan_id = (SELECT MAX(id) FROM watchlist_sync.plans) AND list_key = 'trim_risk' AND l1_pass`);
      const trim = new Set((tr as Array<Record<string, unknown>>).map((r) => String(r.ticker)));
      // A196: drift check demoted put edge → plain option-score order, still never trim names (missing table = not demoted)
      const { rows: st } = await db.execute(sql`SELECT demoted FROM watchlist_sync.put_edge_status ORDER BY as_of DESC LIMIT 1`).catch(() => ({ rows: [] }));
      if ((st[0] as Record<string, unknown> | undefined)?.demoted === true) {
        const keep = new Set(rows.filter((r) => !trim.has(r.ticker)).slice(0, FOCUS_PUTS).map((r) => r.ticker));
        rows.forEach((r) => { r.focus = keep.has(r.ticker); r.edge = null; });
        return;
      }
      const { rows: er } = await db.execute(sql`SELECT ticker, quintile, pnl_bp, breach, iv_rv FROM watchlist_sync.put_edge_daily
        WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.put_edge_daily WHERE as_of >= CURRENT_DATE - 7)`);
      const em = new Map((er as Array<Record<string, unknown>>).map((r) => [String(r.ticker), r]));
      for (const r of rows) {
        const e = em.get(r.ticker);
        r.edge = e ? { quintile: Number(e.quintile), pnlBp: num(e.pnl_bp as number | null), breach: num(e.breach as number | null), ivRv: num(e.iv_rv as number | null) } : null;
      }
      const pick = rows.filter((r) => (r.edge?.quintile ?? 0) >= 4 && !trim.has(r.ticker))
        .sort((a, b) => (b.edge!.quintile - a.edge!.quintile) || (b.optionScore - a.optionScore)).slice(0, FOCUS_PUTS);
      // Missing coverage may use plain scores; observed ineligibility must stay empty.
      const hasCoverage = rows.some((r) => r.edge !== null);
      const fallback = rows.filter((r) => !trim.has(r.ticker)).slice(0, FOCUS_PUTS);
      const set = new Set((hasCoverage ? pick : fallback).map((r) => r.ticker));
      for (const r of rows) r.focus = set.has(r.ticker);
    } else {
      const { rows: held } = await db.execute(sql`SELECT UPPER(symbol) AS t FROM portfolio_positions
        WHERE snapshot_id = (SELECT MAX(id) FROM portfolio_snapshots) GROUP BY 1 HAVING SUM(quantity) >= 100`);
      const hs = new Set((held as Array<Record<string, unknown>>).map((r) => String(r.t)));
      const set = new Set(rows.filter((r) => hs.has(r.ticker)).slice(0, FOCUS_CALLS).map((r) => r.ticker));
      for (const r of rows) r.focus = set.has(r.ticker);
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "option rankings: focus/edge unavailable");
    // Unknown trim/ownership eligibility must never become a recommendation.
    rows.forEach((r) => { r.focus = false; r.edge = null; });
  }
}

export async function computeAndPersistOptionScores(opts?: {
  asOf?: string;
  limit?: number;
  dryRun?: boolean;
  /** Reuse chains from a sibling job (e.g. Friday model snapshot). */
  chainsByTicker?: Map<string, OptionsChainResult[]>;
  /** Score only these tickers (gap backfill). Still requires technicals rows. */
  onlyTickers?: string[];
}): Promise<{
  asOf: string;
  candidates: number;
  persisted: number;
  failures: number;
  liveBidCount: number;
  top: Array<{ ticker: string; side: string; score: number; weekly: number | null }>;
}> {
  const asOf = opts?.asOf ?? todayStr();
  const limit = opts?.limit ?? CANDIDATE_LIMIT;
  const dryRun = opts?.dryRun === true;

  const { getChampionScorecardParams } = await import("./scorecard-params.js");
  const optChamp = await getChampionScorecardParams("options");
  const { createHash } = await import("crypto");
  // Ensure A14 columns exist (idempotent)
  const { pool } = await import("@workspace/db");
  await pool.query(`
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS coverage numeric;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS confidence text;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS model_version text;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS inputs_digest text;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS shadow_score numeric;
    ALTER TABLE option_score_snapshots ADD COLUMN IF NOT EXISTS shadow_version text;
  `);

  const [techRows, volRegimeResult, macroRegimeName, tiltState, calibration, watchlistTickers] = await Promise.all([
    getAllTechnicalsRows(),
    getMacroRegimeResult(),
    getLatestRegime(),
    getTiltState(),
    getCalibrationTable(),
    getUnionWatchlistTickers(),
  ]);
  const volRegime: MacroRegime = volRegimeResult.regime;
  const rows = techRows as unknown as TechnicalRow[];
  const putWeights = (optChamp.params.strikeWeights ?? undefined) as Record<string, number> | undefined;
  const putPolicy = applyPolicy(tiltState.put, putWeights, { regime: macroRegimeName });
  const callPolicy = applyPolicy(tiltState.call, CALL_STRIKE_WEIGHTS, { regime: macroRegimeName });

  const techSet = new Set(rows.map((r) => r.ticker.toUpperCase()));
  const premium = selectPremiumCandidates(
    rows.map((r) => ({
      ticker: r.ticker,
      atmPutIv: r.atmPutIv,
      ivVsRealizedVol: r.ivVsRealizedVol,
      technicalsCoverage: r.technicalsCoverage,
    })),
    limit,
  );
  // Watchlist Rankings seeds from these snapshots — always attempt every watchlist
  // name that has technicals, not only the premium-IV Overall shortlist.
  const watchlistInTech = watchlistTickers
    .map((t) => t.toUpperCase())
    .filter((t) => techSet.has(t));
  let candidates = [...new Set([...premium, ...watchlistInTech])];
  if (opts?.onlyTickers?.length) {
    const only = new Set(opts.onlyTickers.map((t) => t.toUpperCase()));
    candidates = candidates.filter((t) => only.has(t));
  }

  logger.info(
    { premium: premium.length, watchlist: watchlistInTech.length, candidates: candidates.length, only: opts?.onlyTickers?.length ?? 0 },
    "option-score-snapshots: universe",
  );

  let fundScoreMap = new Map<string, number>();
  try {
    const scores = (await readPersistedScores(macroRegimeName))
      ?? (await computeAndPersistFundamentalScores(macroRegimeName));
    fundScoreMap = new Map(
      scores
        .filter((s): s is typeof s & { totalScore: number } => s.totalScore != null)
        .map((s) => [s.ticker, s.totalScore]),
    );
  } catch (err) {
    logger.warn({ err }, "option-score-snapshots: fund scores unavailable");
  }

  // A167/A170: put + call lanes use the options champion's lane tech weights (S045/S046); display keeps defaults.
  const putTechWeights = (optChamp.params.putTechWeights ?? undefined) as Record<string, number> | undefined;
  const callTechWeights = (optChamp.params.callTechWeights ?? undefined) as Record<string, number> | undefined;
  const putRankings = putTechScores(rows, putTechWeights);
  const ivRanks = await loadIvRanks();   // true IV percentile (iv_rank.py resolver), not the RV proxy in techRow.ivRank
  const volumeNodes = await loadVolumeNodes(candidates);
  const callRankings = laneTechScores(rows, callTechWeights, "call");
  const techRowMap = new Map(rows.map((r) => [r.ticker, r]));

  // A172/A191: challenger or parent — re-score the same put strike only (picks unchanged).
  const shadowInputs = await loadShadowInputs();
  const shadowPutRankings = shadowInputs
    ? putTechScores(rows, shadowInputs.putTechWeights)
    : null;
  const shadowPutPolicy = shadowInputs
    ? applyPolicy(tiltState.put, shadowInputs.strikeWeights, { regime: macroRegimeName })
    : null;
  const putEdgeFactors = shadowInputs
    ? await loadPutEdgeFactors(candidates, asOf) // A255: as-of + universe rank; shadowCtx only
    : new Map();

  let chainsByTicker: Map<string, OptionsChainResult[]>;
  let failures: number;
  if (opts?.chainsByTicker) {
    chainsByTicker = opts.chainsByTicker;
    failures = 0;
  } else {
    const fetched = await fetchChainsForTickers(candidates, {
      concurrency: CHAIN_CONCURRENCY,
      logLabel: "option-score-snapshots",
    });
    chainsByTicker = fetched.chainsByTicker;
    failures = fetched.failures;
    if (!dryRun) await persistChainHistory(chainsByTicker, asOf); // same chains, no extra API calls
    if (!dryRun) {
      // Index chains for dealer-gamma research (A109; user 10-15): 2 extra calls, history only — never scored.
      const idx = await fetchChainsForTickers(["SPY", "QQQ"], { concurrency: 2, logLabel: "option-chain-history:index" });
      await persistChainHistory(idx.chainsByTicker, asOf);
    }
  }

  // A256: side-specific IV universes for ivAbsolute (puts≠calls).
  const putIVs = collectSideIVsFromChainMap(chainsByTicker.values(), false);
  const callIVs = collectSideIVsFromChainMap(chainsByTicker.values(), true);

  /** Watchlist names get a relaxed second pass so Rankings isn't blank when Overall gates fire. */
  const watchlistSet = new Set(watchlistInTech);
  /** Soft income floor for watchlist-only persistence (still live bid + ≥2% OTM). */
  const WATCHLIST_INCOME_FLOOR = 0.02;

  const inserts: InsertOptionScoreSnapshot[] = [];
  let liveBidCount = 0;
  let watchlistRelaxed = 0;
  for (const [ticker, chains] of chainsByTicker) {
    const techRow = techRowMap.get(ticker);
    if (!techRow || chains.length === 0) continue;
    const onWatchlist = watchlistSet.has(ticker.toUpperCase());

    for (const side of ["put", "call"] as const) {
      const isCall = side === "call";
      const sideIVs = isCall ? callIVs : putIVs;
      const incomeFloor = isCall ? CALL_INCOME_FLOOR : INCOME_FLOOR;
      const stockCtx: StockContext = {
        ivRank:                ivRanks.get(ticker) ?? null,
        ivPercentile:          null,   // was the same RV proxy again (counted twice)
        ivVsRealizedVol:       num(techRow.ivVsRealizedVol),
        basicSkew:             num(techRow.basicSkew),
        swingLow20d:           num(techRow.swingLow20d),
        swingLow50d:           num(techRow.swingLow50d),
        pivotS1:               num(techRow.pivotS1),
        swingHigh20d:          num(techRow.swingHigh20d),
        swingHigh50d:          num(techRow.swingHigh50d),
        pivotR1:               num(techRow.pivotR1),
        nearestSupportDistPct: num(techRow.nearestSupportDistPct),
        techTotalScore:        (isCall ? callRankings : putRankings).get(ticker) ?? null,
        fundTotalScore:        fundScoreMap.get(ticker) ?? null,
        earningsDaysOut:       num(techRow.earningsDaysOut),
        volumeNodes:           volumeNodes.get(ticker) ?? null,
      };
      const policy = isCall ? callPolicy : putPolicy;
      const sideChains = chains.map((c) => ({ ...c, options: isCall ? c.calls : c.puts }));
      let best = pickBestStrike(
        sideChains,
        stockCtx, volRegime, sideIVs, undefined,
        policy.weights, isCall,
        {
          minStockQuality: policy.sqFloor,
          calibration,
          earningsHaircut: policy.earningsHaircut,
        },
      );
      let relaxed = false;
      if (!best && onWatchlist) {
        // Fund score missing or thin premium — still show a scored live-bid strike on Watchlist.
        best = pickBestStrike(
          sideChains,
          stockCtx, volRegime, sideIVs, undefined,
          policy.weights, isCall,
          {
            minStockQuality: 0,
            calibration: null,
            earningsHaircut: policy.earningsHaircut,
            incomeFloor: WATCHLIST_INCOME_FLOOR,
            minOtm: 0.02,
          },
        );
        relaxed = true;
        if (best) watchlistRelaxed++;
      }
      if (!best) continue;
      const otmCheck = spotOtm(best.chain.spot, best.put.strike, isCall);
      // Strict path already passed viability inside pickBestStrike; relaxed too.
      if (!relaxed) {
        const floor = incomeFloor * 0.9;
        if (!isViablePremiumIncome(best.result.weeklyIncome, otmCheck, { incomeFloor: floor })) continue;
      } else if (!isViablePremiumIncome(best.result.weeklyIncome, otmCheck, {
        incomeFloor: WATCHLIST_INCOME_FLOOR,
        minOtm: 0.02,
      })) continue;

      const opt = best.put as OptionRow;
      const chain = best.chain;
      const premium = opt.bid;
      if (!(premium > 0) || !opt.bidIsLive) continue;
      liveBidCount++;

      const spot = chain.spot;
      const otm = otmCheck;

      let shadowScore: string | null = null;
      let shadowVersion: string | null = null;
      // A256: skip shadow/champion grade on relaxed fallbacks (would flatter the champion).
      if (!relaxed && !isCall && shadowInputs && shadowPutRankings && shadowPutPolicy) {
        const edge = putEdgeFactors.get(ticker);
        // A255: TS put-edge = two shadow marginal percentiles only — never on stockCtx / live pick.
        const shadowCtx: StockContext = {
          ...stockCtx,
          techTotalScore: shadowPutRankings.get(ticker) ?? null,
          ivRvUniversePct: edge?.ivRvPct ?? null,
          volOfVolPct: edge?.volOfVolPct ?? null,
        };
        const sh = scoreShadowOnChosenStrike({
          opt,
          chain,
          stockCtx: shadowCtx,
          regime: volRegime,
          allWatchlistIVs: sideIVs,
          strikeWeights: shadowPutPolicy.weights,
          earningsHaircut: shadowPutPolicy.earningsHaircut,
          calibration,
        });
        if (sh != null) {
          shadowScore = String(sh);
          shadowVersion = shadowInputs.version;
        }
      }

      const componentScores: Record<string, unknown> = {
        ...best.result.componentScores,
        ...(relaxed ? { relaxed: RELAXED_COMPONENT } : {}),
      };

      inserts.push({
        ticker,
        side,
        asOf,
        strike: String(opt.strike),
        expiry: chain.expiry,
        spot: String(spot),
        premium: String(premium),
        weeklyIncomePct: String(best.result.weeklyIncome),
        otmPct: otm != null ? String(otm) : null,
        delta: opt.delta != null ? String(opt.delta) : null,
        strikeIv: opt.iv > 0 ? String(opt.iv) : null,
        dte: String(chain.exactDte),
        optionScore: String(best.result.optionScore),
        componentScores,
        earningsDaysOut: techRow.earningsDaysOut ?? null,
        earningsRisk: best.result.earningsRisk,
        bidIsLive: best.result.bidIsLive,
        quoteStale: best.result.quoteStale,
        dataQuality: String(best.result.dataQuality),
        atmPutIv: techRow.atmPutIv != null ? String(techRow.atmPutIv) : null,
        ivVsRealized: techRow.ivVsRealizedVol != null ? String(techRow.ivVsRealizedVol) : null,
        coverage: String(best.result.dataQuality ?? 1),
        confidence: best.result.bidIsLive && !best.result.quoteStale ? "high" : "low",
        modelVersion: optChamp.version,
        shadowScore,
        shadowVersion,
        inputsDigest: createHash("sha1")
          .update(JSON.stringify({ ticker, side, strike: opt.strike, expiry: chain.expiry, spot, premium }))
          .digest("hex")
          .slice(0, 16),
        computedAt: new Date(),
      });
    }
  }

  if (!dryRun && inserts.length > 0) {
    // Upsert only — never DELETE … WHERE as_of = today (partial runs wiped the day).
    const CHUNK = 50;
    for (let i = 0; i < inserts.length; i += CHUNK) {
      await db.insert(optionScoreSnapshots).values(inserts.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [optionScoreSnapshots.ticker, optionScoreSnapshots.side, optionScoreSnapshots.asOf],
          set: {
            strike: sql`excluded.strike`,
            expiry: sql`excluded.expiry`,
            spot: sql`excluded.spot`,
            premium: sql`excluded.premium`,
            weeklyIncomePct: sql`excluded.weekly_income_pct`,
            otmPct: sql`excluded.otm_pct`,
            delta: sql`excluded.delta`,
            strikeIv: sql`excluded.strike_iv`,
            dte: sql`excluded.dte`,
            optionScore: sql`excluded.option_score`,
            componentScores: sql`excluded.component_scores`,
            earningsDaysOut: sql`excluded.earnings_days_out`,
            earningsRisk: sql`excluded.earnings_risk`,
            bidIsLive: sql`excluded.bid_is_live`,
            quoteStale: sql`excluded.quote_stale`,
            dataQuality: sql`excluded.data_quality`,
            atmPutIv: sql`excluded.atm_put_iv`,
            ivVsRealized: sql`excluded.iv_vs_realized`,
            coverage: sql`excluded.coverage`,
            confidence: sql`excluded.confidence`,
            modelVersion: sql`excluded.model_version`,
            shadowScore: sql`excluded.shadow_score`,
            shadowVersion: sql`excluded.shadow_version`,
            inputsDigest: sql`excluded.inputs_digest`,
            computedAt: sql`excluded.computed_at`,
          },
        });
    }
  }

  const top = inserts
    .slice()
    .sort((a, b) => Number(b.optionScore) - Number(a.optionScore))
    .slice(0, 15)
    .map((r) => ({
      ticker: r.ticker,
      side: r.side,
      score: Number(r.optionScore),
      weekly: num(r.weeklyIncomePct),
    }));

  logger.info(
    { asOf, candidates: candidates.length, persisted: dryRun ? 0 : inserts.length, failures, liveBidCount, watchlistRelaxed },
    "option-score-snapshots: complete",
  );

  return {
    asOf,
    candidates: candidates.length,
    persisted: dryRun ? 0 : inserts.length,
    failures,
    liveBidCount,
    top,
  };
}


/** A192 Structures board: catalog + today's picks (primary / more / study tiers from structures.py)
 *  + house-view stance. Table reads only. */
  export async function readStructuresBoard(): Promise<{
    asOf: string | null;
    stance: string | null;
    stanceAsOf: string | null;
    structures: Array<{ id: string; name: string; family: string; description: string; regime: string; evidence: string;
      evidenceNote: string; rows: Array<Record<string, unknown>> }>;
  }> {
    try {
      const { rows: cat } = await db.execute(sql`SELECT id, name, family, description, regime, evidence, evidence_note FROM watchlist_sync.structure_catalog`);
      const { rows: rk } = await db.execute(sql`SELECT as_of::text AS as_of, structure, rank, payload FROM watchlist_sync.structure_rank_daily
        WHERE as_of = (SELECT MAX(as_of) FROM watchlist_sync.structure_rank_daily) ORDER BY structure, rank`);
      const { rows: hv } = await db.execute(sql`SELECT view_date::text AS view_date, memo FROM watchlist_sync.house_view ORDER BY view_date DESC LIMIT 1`);
      const memo = String((hv[0] as Record<string, unknown> | undefined)?.memo ?? "");
      const stanceAsOf = ((hv[0] as Record<string, unknown> | undefined)?.view_date as string | undefined) ?? null;
      // Drop the "Stance (rules, not vibes)." label — desk only needs the action clause.
      // Prefer plain **Do.** line; fall back to jargon **Stance.**
      const doRaw = memo.split("\n").find((l) => /\*\*Do\./i.test(l) || /^Do\./i.test(l)) ?? null;
      const stanceRaw = memo.split("\n").find((l) => /\*\*Stance/i.test(l) || /^Stance\b/i.test(l)) ?? null;
      const pick = doRaw ?? stanceRaw;
      const stance = pick
        ? pick
            .replace(/\*\*/g, "")
            .replace(/^(Do|Stance)\s*(\([^)]*\))?\s*[.:–—-]?\s*/i, "")
            .trim() || null
        : null;
    const by = new Map<string, Array<Record<string, unknown>>>();
    for (const r of rk as Array<Record<string, unknown>>) {
      const k = String(r.structure);
      if (!by.has(k)) by.set(k, []);
      by.get(k)!.push(r.payload as Record<string, unknown>);
    }
    const order = ["pass", "untested", "fail"];
    const structures = (cat as Array<Record<string, unknown>>).map((c) => ({
      id: String(c.id), name: String(c.name), family: String(c.family), description: String(c.description), regime: String(c.regime),
      evidence: String(c.evidence), evidenceNote: String(c.evidence_note), rows: by.get(String(c.id)) ?? [],
    })).sort((a, b) => (b.rows.length > 0 ? 1 : 0) - (a.rows.length > 0 ? 1 : 0) || order.indexOf(a.evidence) - order.indexOf(b.evidence));
    return {
      asOf: (rk[0] as Record<string, unknown> | undefined)?.as_of as string ?? null,
      stance,
      stanceAsOf,
      structures,
    };
  } catch (err) {
    logger.warn({ err: String(err) }, "structures board unavailable");
    return { asOf: null, stance: null, stanceAsOf: null, structures: [] };
  }
}
