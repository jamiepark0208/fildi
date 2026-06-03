import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stocksRouter from "./stocks";
import indicatorsRouter from "./indicators";
import optionsRouter from "./options";
import technicalRouter from "./technical";
import dailyBriefRouter from "./daily-brief";
import macroRouter from "./macro";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stocksRouter);
router.use(indicatorsRouter);
router.use(optionsRouter);
router.use(technicalRouter);
router.use(dailyBriefRouter);
router.use("/macro", macroRouter);

export default router;
