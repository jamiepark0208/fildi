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
import { requireAuth } from "../middleware/requireAuth.js";

const router: IRouter = Router();

// PUBLIC_PATHS: health + auth only. Everything else below either mounts its
// own requireAuth/requireAdmin per-route, or sits on protectedRouter (bug/1).
router.use(healthRouter);
router.use(authRouter);

// Vendor-cost routes (Yahoo/Anthropic/SDM on cache miss) — bug/1: these had
// zero auth, relying on the FE's ProtectedRoute which is not a security
// boundary. Everything else in this file already gates POST/PUT/DELETE with
// requireAdmin or requireAuth per-route and its public GETs are DB/file reads.
const protectedRouter: IRouter = Router();
protectedRouter.use(requireAuth);
protectedRouter.use(stocksRouter);
protectedRouter.use(indicatorsRouter);
protectedRouter.use(optionsRouter);
protectedRouter.use(technicalRouter);
protectedRouter.use(explainRouter);
protectedRouter.use(sdmRouter);
router.use(protectedRouter);

router.use(watchlistRouter);
router.use(scoringConfigRouter);
router.use(feedRouter);
router.use(dailyBriefRouter);
router.use("/macro", macroRouter);
router.use(fundamentalsRouter);
router.use(fundamentalsProvenanceRouter);
router.use(technicalsRouter);
router.use(macroRegimeRouter);
router.use(adminCacheRouter);
router.use(portfolioIngestRouter);
router.use(portfolioSnapshotRouter);
router.use(cotRouter);
router.use(regimeRouter);
router.use(apiUsageRouter);
router.use(dataHealthRouter);

export default router;
