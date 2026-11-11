import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stocksRouter from "./stocks";
import indicatorsRouter from "./indicators";
import optionsRouter from "./options";
import technicalRouter from "./technical";
import dailyBriefRouter from "./daily-brief";
import macroRouter from "./macro";
import macroThemesRouter from "./macro-themes";
import fundamentalsRouter from "./fundamentals";
import fundamentalsProvenanceRouter from "./fundamentals-provenance";
import peerOverridesRouter from "./peer-overrides";
import fundamentalsRefetchQueueRouter from "./fundamentals-refetch-queue";
import technicalsRouter from "./technicals";
import explainRouter from "./explain";
import sdmRouter from "./sdm";
import macroRegimeRouter from "./macro-regime";
import authRouter from "./auth";
import watchlistRouter from "./watchlist";
import scoringConfigRouter from "./scoring-config";
import feedRouter from "./feed";
import adminCacheRouter from "./admin-cache";
import portfolioIngestRouter from "./portfolio-ingest";
import portfolioSnapshotRouter from "./portfolio-snapshot";
import cotRouter from "./macro-cot";
import regimeRouter from "./regime";
import apiUsageRouter from "./api-usage";
import dataHealthRouter from "./data-health";
import localStackRouter from "./local-stack";
import enrichmentRunsRouter from "./enrichment-runs";
import scheduledTasksRouter from "./scheduled-tasks";
import deskCommentariesRouter from "./desk-commentaries";
import deskDailyNewsRouter from "./desk-daily-news";
import pmAlertsRouter from "./pm-alerts";
import putManageRouter from "./put-manage";
import stockContextRouter from "./stock-context";
import fairValueAssumptionsRouter from "./fair-value-assumptions";
import convictionRouter from "./conviction";
import optionsHistoryRouter from "./options-history";
import volMetricsRouter from "./vol-metrics";
import strategyRulesRouter from "./strategy-rules";
import putBandRouter from "./put-band";
import agentsRouter from "./agents";
import agentsDrillRouter from "./agents-drill";
import clientTelemetryRouter from "./client-telemetry";
import schwabRouter, { schwabMachineRouter } from "./schwab";
import positionsRouter from "./positions";
import feedbackRouter from "./feedback";
import liveRouter from "./live";
import indexMoversRouter from "./index-movers";
import trackRecordRouter from "./track-record";
import strategiesRouter from "./strategies";
import researchWrdsRouter from "./research-wrds";
import researchLsegRouter from "./research-lseg";
import researchOpsRouter from "./research-ops";
import scoreOutliersRouter from "./score-outliers";
import moverFactsRouter from "./mover-facts";
import longOptionBoardRouter from "./long-option-board";
import stockEdgesRouter from "./stock-edges";
import congressRouter from "./congress";
import fundScoreNotesRouter from "./fund-score-notes";
import backtestRouter from "./backtest";
import { requireAuth } from "../middleware/requireAuth.js";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { explainLimiter } from "../middleware/rateLimiter.js";

const router: IRouter = Router();

// PUBLIC_PATHS: health + auth, plus every router below down to the
// "vendor-cost" block that stays DB/file-read-only with no session.
router.use(healthRouter);
router.use(authRouter);
router.use(scoringConfigRouter);
router.use(dailyBriefRouter);
router.use(deskCommentariesRouter);
router.use(deskDailyNewsRouter);
router.use(pmAlertsRouter);
router.use(putManageRouter);
router.use(fairValueAssumptionsRouter);
router.use(convictionRouter);
router.use(agentsRouter);
router.use(agentsDrillRouter);
// Loopback quote helpers for local scripts. No session cookie. Each handler 403s non-loopback.
router.use(schwabMachineRouter);
router.use("/macro", macroRouter);
router.use("/macro", macroThemesRouter);   // Key Themes + money flows (Jamie 10-28)
router.use(fundamentalsRouter);
router.use(fundamentalsProvenanceRouter);
router.use(peerOverridesRouter);
router.use(fundamentalsRefetchQueueRouter);
router.use(macroRegimeRouter);
router.use(adminCacheRouter);
router.use(portfolioIngestRouter);
router.use(portfolioSnapshotRouter);
router.use(cotRouter);
router.use(regimeRouter);
router.use(apiUsageRouter);
router.use(dataHealthRouter);
router.use(localStackRouter);
router.use(enrichmentRunsRouter);
router.use(scheduledTasksRouter);

// bug/1: vendor-cost routes (Yahoo/Anthropic/SDM on cache miss) had zero
// auth. Path-scoped directly on the parent router — NOT a blanket
// `subRouter.use(requireAuth)` — because a sub-router mounted with no path
// prefix still runs its own internal middleware for every request that
// reaches it, even ones matching nothing inside it, before falling through.
// A no-path `.use(requireAuth)` in that position becomes a global gate for
// everything mounted after it in this file, which is exactly what broke
// dailyBrief/macro/etc when first tried (see watchlist.ts/feed.ts note below).
router.use(["/stocks", "/indicators", "/options", "/technical", "/technicals", "/explain", "/sdm", "/live", "/track-record", "/strategies", "/schwab", "/research", "/client", "/backtest"], requireAuth);
router.use(clientTelemetryRouter);
// A235 P0: licensed research caches — admin only until entitlement registry (A233).
// Do NOT use bare "/research" (would sweep research-ops). Path-scoped like bug/1.
router.use(["/research/wrds", "/research/lseg"], requireAdmin);
// explainLimiter reads req.session.userId, so it must be mounted after requireAuth
// above (same path-scoped pattern — see bug/1 note) — caps per-user Haiku spend.
router.use("/explain", explainLimiter);
// These routers own /stocks, /schwab, and /research paths. Mounted before the
// gate they answered without a session (the gate never saw the request).
// /pm/* on options-history stays on requireAdmin. Frontend fetches send the session cookie.
router.use(stockContextRouter);
router.use(optionsHistoryRouter);
router.use(volMetricsRouter);
router.use(strategyRulesRouter); // Rankings › Rules (strategy_rules.json)
router.use(putBandRouter); // sold-put band setting (Jamie 10-28), under /strategies → requireAuth
router.use(stockEdgesRouter); // Breakdown › Rules firing today (/stocks/:t/edges); before stocksRouter
router.use(congressRouter); // A394 congress trades (/stocks/:t/congress, /congress/latest); before stocksRouter
router.use(schwabRouter);
router.use(stocksRouter);
router.use(fundScoreNotesRouter);
router.use(indicatorsRouter);
router.use(longOptionBoardRouter); // S086 Rankings › Long options; before optionsRouter (/options/:ticker)
router.use(moverFactsRouter); // before optionsRouter: its /options/:ticker 400'd "mover-facts" as a bad ticker
router.use(optionsRouter);
// /technicals is not covered by the /technical prefix. No Python job calls these
// routes (loopback callers use /schwab/option-quotes and /schwab/equity-prices).
// Frontend fetches send the session cookie.
router.use(technicalsRouter);
router.use(technicalRouter);
router.use(explainRouter);
router.use(sdmRouter);
router.use(liveRouter);
router.use(indexMoversRouter);
router.use(trackRecordRouter);
router.use(backtestRouter);
router.use(strategiesRouter);
// Local research caches (WRDS/LSEG) — DB read only, never live vendor calls.
router.use(researchWrdsRouter);
router.use(researchLsegRouter);
router.use(researchOpsRouter);
router.use(scoreOutliersRouter);

// watchlist.ts + feed.ts: internal requireAuth. positions.ts: internal requireAdmin
// (A235 — stale comment used to say requireAuth). Paths are baked in (e.g. "/watchlist"),
// so they can't be mounted at a matching path prefix without double-prefixing. Keep LAST.
// Do not insert new routers below this line.
//
// bug/14 (2026-07-11): positionsRouter existed as a file but was never
// mounted here, so /api/positions + /api/portfolio-names 404'd — the
// server-backed CRUD the frontend now depends on (use-portfolio.ts) requires
// this line.
router.use(watchlistRouter);
router.use(feedRouter);
router.use(positionsRouter);
router.use(feedbackRouter);

export default router;
