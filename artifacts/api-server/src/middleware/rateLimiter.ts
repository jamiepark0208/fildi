import rateLimit from "express-rate-limit";

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
