import * as Sentry from "@sentry/node";
import express, { type Express } from "express";
import helmet from "helmet";
import cors from "cors";
import pinoHttp from "pino-http";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "@workspace/db";
import router from "./routes";
import { logger } from "./lib/logger";
import { generalLimiter } from "./middleware/rateLimiter";
import { errorHandler } from "./middleware/errorHandler";
import { requestId } from "./middleware/requestId";

if (process.env["SENTRY_DSN"]) {
  Sentry.init({
    dsn: process.env["SENTRY_DSN"],
    environment: process.env["NODE_ENV"] ?? "development",
    // Only capture errors, no performance tracing in v1
    tracesSampleRate: 0,
  });
}

const app: Express = express();

// bug/7: behind a reverse proxy (Replit), req.ip is the proxy's IP unless we trust
// X-Forwarded-For — without this every client shares one rate-limit bucket. `1` = trust
// exactly one hop (the proxy in front of us), not the full chain, to avoid IP spoofing.
if (process.env["NODE_ENV"] === "production") {
  app.set("trust proxy", 1);
}

app.use(requestId);
app.use(helmet());
app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({
  origin: process.env['FRONTEND_URL'] ?? 'http://localhost:3000',
  credentials: true,
}));
app.use(generalLimiter);
const PgSession = connectPgSimple(session as any);
// express-session uses CJS `export =`; bundler moduleResolution can't synthesize callable default
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use((session as any)({
  store: new PgSession({ pool, tableName: 'session', pruneSessionInterval: 900 }), // bug/18: 15-min expired-row cleanup
  secret: process.env['SESSION_SECRET']!,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: process.env['NODE_ENV'] === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  },
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);
if (process.env["SENTRY_DSN"]) {
  Sentry.setupExpressErrorHandler(app);
}
app.use(errorHandler);

export default app;
