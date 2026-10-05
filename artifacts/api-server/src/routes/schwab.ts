/**
 * GET /api/schwab/status — auth / refresh-token health + light usage stats (no secrets).
 */
import { Router } from "express";
import { getSchwabAuthStatus } from "../lib/schwab-auth.js";
import { getSchwabUsageStats, schwabAvailable } from "../lib/schwab-client.js";

const router = Router();

router.get("/schwab/status", (_req, res) => {
  const s = getSchwabAuthStatus();
  const refreshDaysLeft = s.refreshDaysLeft != null
    ? Math.round(s.refreshDaysLeft * 10) / 10
    : null;
  const usage = getSchwabUsageStats();
  return res.json({
    ...s,
    refreshDaysLeft,
    clientReady: schwabAvailable() && s.hasTokens && (refreshDaysLeft == null || refreshDaysLeft > 0),
    reauthHint:
      !s.hasTokens
        ? "Run: node --env-file=.env.local scripts/schwab-oauth.mjs"
        : refreshDaysLeft != null && refreshDaysLeft < 1
          ? "Refresh token expires within 24h — re-run scripts/schwab-oauth.mjs"
          : refreshDaysLeft != null && refreshDaysLeft < 2
            ? "Refresh token expires within 48h — plan re-auth soon"
            : null,
    usage,
  });
});

export default router;
