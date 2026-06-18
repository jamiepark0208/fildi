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

const app: Express = express();

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
  store: new PgSession({ pool, tableName: 'session' }),
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
app.use(errorHandler);

export default app;
