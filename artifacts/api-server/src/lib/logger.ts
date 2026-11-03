import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          // Date in every line: api.log spans days of sleeps/restarts, and time-only stamps made perf-watch misdate hangs.
          options: { colorize: true, translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l" },
        },
      }),
});
