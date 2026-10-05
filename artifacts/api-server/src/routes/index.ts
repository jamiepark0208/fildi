import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stocksRouter from "./stocks";
import indicatorsRouter from "./indicators";
import optionsRouter from "./options";
import technicalRouter from "./technical";
import dailyBriefRouter from "./daily-brief";
import macroRouter from "./macro";
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
import schwabRouter from "./schwab";
import positionsRouter from "./positions";
import feedbackRouter from "./feedback";
import liveRouter from "./live";
import trackRecordRouter from "./track-record";
import { requireAuth } from "../middleware/requireAuth.js";
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
router.use(schwabRouter);
router.use("/macro", macroRouter);
router.use(fundamentalsRouter);
router.use(fundamentalsProvenanceRouter);
router.use(peerOverridesRouter);
router.use(fundamentalsRefetchQueueRouter);
router.use(technicalsRouter);
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
router.use(["/stocks", "/indicators", "/options", "/technical", "/explain", "/sdm", "/live", "/track-record", "/schwab"], requireAuth);
// explainLimiter reads req.session.userId, so it must be mounted after requireAuth
// above (same path-scoped pattern — see bug/1 note) — caps per-user Haiku spend.
router.use("/explain", explainLimiter);
router.use(stocksRouter);
router.use(indicatorsRouter);
router.use(optionsRouter);
router.use(technicalRouter);
router.use(explainRouter);
router.use(sdmRouter);
router.use(liveRouter);
router.use(trackRecordRouter);

// watchlist.ts, feed.ts, and positions.ts each have their own internal
// blanket `router.use(requireAuth)` (all-user-specific routes, intentional),
// and their route paths are already baked in (e.g. "/watchlist"), so they
// can't be mounted at a matching path prefix without double-prefixing. Same
// leak risk as above — keep these LAST so there's nothing left downstream to
// leak auth onto. Do not insert new routers below this line.
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
