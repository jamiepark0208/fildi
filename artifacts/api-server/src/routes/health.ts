import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getPoolErrorStats } from "@workspace/db";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  const poolErr = getPoolErrorStats();
  // Keep zod shape (status only); degraded when pool saw client drops since boot (A251).
  const status = poolErr.count > 0 ? "degraded" : "ok";
  const data = HealthCheckResponse.parse({ status });
  res.json({
    ...data,
    dbPoolErrors: poolErr.count,
    dbPoolLastError: poolErr.last,
  });
});

export default router;
