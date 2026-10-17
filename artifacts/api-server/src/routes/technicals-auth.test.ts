import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";
import express from "express";

// Same-origin browser fetches send the session cookie. No Python job calls /api/technicals.
const PATHS: Array<[string, string]> = [
  ["/api/technicals/rankings", "GET"],
  ["/api/technicals/all", "GET"],
  ["/api/technicals/status", "GET"],
  ["/api/technicals/AAPL", "GET"],
  ["/api/technicals/refresh", "POST"],
  ["/api/technicals/refresh/AAPL", "POST"],
];

test("technicals routes reject a missing session and health stays public", async () => {
  process.env.DATABASE_URL ??= "postgres://ci:ci@127.0.0.1:5432/ci";
  const { default: router } = await import("./index.ts");
  const app = express();
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = {};
    next();
  });
  app.use("/api", router);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  try {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    for (const [path, method] of PATHS) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 401, `${method} ${path}`);
    }
    const health = await fetch(`${base}/api/healthz`);
    assert.equal(health.status, 200);
  } finally {
    server.close();
    await once(server, "close");
  }
});
