import { Router, type IRouter } from "express";
import healthRouter from "./health";
import stocksRouter from "./stocks";
import indicatorsRouter from "./indicators";
import optionsRouter from "./options";

const router: IRouter = Router();

router.use(healthRouter);
router.use(stocksRouter);
router.use(indicatorsRouter);
router.use(optionsRouter);

export default router;
