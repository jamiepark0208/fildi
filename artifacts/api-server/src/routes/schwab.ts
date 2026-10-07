/**
 * GET /api/schwab/status — auth / refresh-token health + light usage stats (no secrets).
 */
import { Router } from "express";
import { getSchwabAccessToken, getSchwabAuthStatus } from "../lib/schwab-auth.js";
import { getSchwabUsageStats, schwabAvailable } from "../lib/schwab-client.js";
import { getOptionsChainSourceStats } from "../lib/options-chain-source-stats.js";
import { getSchwabOptionQuotes, occSymbol, type OptionContractRef } from "../lib/schwab-option-quotes.js";

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

/**
 * POST /api/schwab/option-quotes {contracts: [{ticker, expiry, strike, type}]} → {quotes: {occ: quote}, symbols: {key: occ}}
 * Localhost only (called by scripts/watchlist_sync/verify_plan.py to re-price plan contracts at verify time).
 */
router.post("/schwab/option-quotes", async (req, res) => {
  const ip = req.socket.remoteAddress ?? "";
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) return res.status(403).json({ error: "localhost only" });
  const list = (req.body?.contracts ?? []) as OptionContractRef[];
  const contracts = list
    .filter((c) => c && typeof c.ticker === "string" && /^\d{4}-\d{2}-\d{2}$/.test(String(c.expiry)) && Number(c.strike) > 0
      && (c.type === "put" || c.type === "call"))
    .slice(0, 200)
    .map((c) => ({ ticker: c.ticker, expiry: String(c.expiry), strike: Number(c.strike), type: c.type }));
  if (contracts.length === 0) return res.status(400).json({ error: "no valid contracts" });
  const quotes = await getSchwabOptionQuotes(contracts);
  if (!quotes) return res.status(503).json({ error: "schwab unavailable" });
  return res.json({ quotes, symbols: Object.fromEntries(contracts.map((c) => [`${c.ticker}|${c.expiry}|${c.strike}|${c.type}`, occSymbol(c)])) });
});

export default router;
