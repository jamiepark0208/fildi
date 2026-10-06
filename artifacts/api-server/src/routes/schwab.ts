/**
 * GET /api/schwab/status — auth / refresh-token health + light usage stats (no secrets).
 */
import { Router } from "express";
import { getSchwabAccessToken, getSchwabAuthStatus } from "../lib/schwab-auth.js";
import { getSchwabUsageStats, schwabAvailable } from "../lib/schwab-client.js";
import { getOptionsChainSourceStats } from "../lib/options-chain-source-stats.js";

const router = Router();

router.get("/schwab/status", async (_req, res) => {
  let s = getSchwabAuthStatus();

  // Access tokens expire ~30m. If credentials + refresh token exist, warm access
  // before reporting so Settings doesn't flash "token issue" while refresh works.
  if (s.configured && s.hasTokens && !s.accessValid) {
    await getSchwabAccessToken();
    s = getSchwabAuthStatus();
  }

  const refreshDaysLeft = s.refreshDaysLeft != null
    ? Math.round(s.refreshDaysLeft * 10) / 10
    : null;
  const usage = getSchwabUsageStats();
  const clientReady =
    s.configured &&
    schwabAvailable() &&
    s.hasTokens &&
    s.accessValid &&
    (refreshDaysLeft == null || refreshDaysLeft > 0);

  let reauthHint: string | null = null;
  if (!s.configured) {
    reauthHint =
      "API missing SCHWAB_CLIENT_ID/SCHWAB_SECRET — restart stack with .env.local loaded (./scripts/dev-restart.sh)";
  } else if (!s.hasTokens) {
    reauthHint = "Run: node --env-file=.env.local scripts/schwab-oauth.mjs";
  } else if (!s.accessValid) {
    reauthHint =
      s.lastError
        ? `Access refresh failed: ${s.lastError}`
        : "Access token invalid — check SCHWAB_* env and re-run schwab-oauth if needed";
  } else if (refreshDaysLeft != null && refreshDaysLeft < 1) {
    reauthHint = "Refresh token expires within 24h — re-run scripts/schwab-oauth.mjs";
  } else if (refreshDaysLeft != null && refreshDaysLeft < 2) {
    reauthHint = "Refresh token expires within 48h — plan re-auth soon";
  }

  return res.json({
    ...s,
    refreshDaysLeft,
    clientReady,
    reauthHint,
    usage,
    /** Process-lifetime: live option chains served via Schwab vs Yahoo fallback */
    optionsChainSource: getOptionsChainSourceStats(),
  });
});

export default router;
