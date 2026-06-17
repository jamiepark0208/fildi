import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stocksRouter from "./stocks";
import indicatorsRouter from "./indicators";
import optionsRouter from "./options";
import technicalRouter from "./technical";
import dailyBriefRouter from "./daily-brief";
import macroRouter from "./macro";
import fundamentalsRouter from "./fundamentals";
import technicalsRouter from "./technicals";
import explainRouter from "./explain";
import sdmRouter from "./sdm";
import macroRegimeRouter from "./macro-regime";
import authRouter from "./auth";
import watchlistRouter from "./watchlist";
import feedRouter from "./feed";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(watchlistRouter);
router.use(feedRouter);
router.use(stocksRouter);
router.use(indicatorsRouter);
router.use(optionsRouter);
router.use(technicalRouter);
router.use(dailyBriefRouter);
router.use("/macro", macroRouter);
router.use(fundamentalsRouter);
router.use(technicalsRouter);
router.use(explainRouter);
router.use(sdmRouter);
router.use(macroRegimeRouter);

export default router;
