import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { getPoolErrorStats } from "@workspace/db";

const router: IRouter = Router();

// 11-23: API ran 2+ days with every outbound fetch failing ('fetch failed' ×4.8k: Breakdown 500, Portfolio quotes 500)
// while a fresh process fetched fine; healthz only checked the DB. Probe outbound from inside the process
// (≤ 1 per 5 min, 5 s deadline, in the background); health-check.mjs fails api_healthz when this is false but its own fetch works → maintain restarts.
const PROBE_URLS = ["https://query1.finance.yahoo.com/v8/finance/chart/SPY?range=1d", "https://api.schwabapi.com/"];
let outbound: { ok: boolean; at: number; err?: string } | null = null;
let probing: Promise<void> | null = null;
function probeOutbound(): Promise<void> {
  probing ??= (async () => {
    let err = "";
    for (const u of PROBE_URLS) {
      try {
        await fetch(u, { method: "GET", signal: AbortSignal.timeout(5000), headers: { "User-Agent": "Mozilla/5.0" } });
        outbound = { ok: true, at: Date.now() };   // any HTTP answer = network path works
        return;
      } catch (e: any) {
        err = String(e?.cause?.code ?? e?.message ?? e);
      }
    }
    outbound = { ok: false, at: Date.now(), err };
  })().finally(() => { probing = null; });
  return probing;
}

router.get("/healthz", (_req, res) => {
  // never blocks: answers with the last probe, refreshes behind (first call after boot → outbound null = unknown)
  if (!outbound || Date.now() - outbound.at > 5 * 60_000) void probeOutbound();
  const poolErr = getPoolErrorStats();
  // Keep zod shape (status only); degraded when pool saw client drops since boot (A251).
  const status = poolErr.count > 0 ? "degraded" : "ok";
  const data = HealthCheckResponse.parse({ status });
  res.json({
    ...data,
    dbPoolErrors: poolErr.count,
    dbPoolLastError: poolErr.last,
    outbound: outbound?.ok ?? null,
    outboundErr: outbound?.ok === false ? outbound.err : undefined,
  });
});

export default router;
