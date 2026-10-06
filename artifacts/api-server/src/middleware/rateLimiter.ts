import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Response } from "express";

// In-memory store, keyed by req.ip (trust-proxy-aware — see app.ts bug/7 fix).
// Single-instance only: if this ever runs as N replicas behind a load balancer, each
// instance gets its own counter, so the effective limit becomes max*N per window. Move
// to a shared store (Redis, enh/29) before horizontally scaling past one instance.

/** Auth + health must never consume the general API budget (login shares same 200/15m cap otherwise). */
function skipGeneralLimit(req: { path: string; originalUrl: string }): boolean {
  const path = req.originalUrl.split("?")[0] ?? req.path;
  return path.startsWith("/api/auth") || path === "/api/healthz";
}

export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipGeneralLimit,
  message: { code: "RATE_LIMITED", message: "Too many requests, please try again later." },
});

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "RATE_LIMITED", message: "Too many login attempts, please try again later." },
});

// Anthropic (Haiku) spend cap — keyed by session userId when present, else IP.
// Apply to EVERY Haiku generate path: /explain/*, daily-brief ?refresh, desk daily-news
// refresh, macro highlights/bank-research generate. Prefer mounting after requireAuth /
// requireAdmin so userId is set.
// Only real Haiku calls spend the budget: handlers that served a cached explanation call
// markAiCached(res, true) and the slot is refunded after the response. Errors still count.
export const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  requestWasSuccessful: (_req, res) => res.locals["aiCached"] === true,
  keyGenerator: (req) => req.session?.userId ? `user:${req.session.userId}` : ipKeyGenerator(req.ip ?? ""),
  message: { code: "RATE_LIMITED", message: "Too many AI requests, please try again later." },
});

/** Tell aiLimiter this response was served from cache (no Anthropic spend) so it is refunded. */
export function markAiCached(res: Response, cached: boolean): void {
  res.locals["aiCached"] = cached;
}

/** @deprecated alias — use aiLimiter */
export const explainLimiter = aiLimiter;
