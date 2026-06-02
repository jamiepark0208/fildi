import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stocksRouter from "./stocks";
import indicatorsRouter from "./indicators";
import optionsRouter from "./options";
import technicalRouter from "./technical";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stocksRouter);
router.use(indicatorsRouter);
router.use(optionsRouter);
router.use(technicalRouter);

export default router;
