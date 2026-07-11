import rateLimit from "express-rate-limit";

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
