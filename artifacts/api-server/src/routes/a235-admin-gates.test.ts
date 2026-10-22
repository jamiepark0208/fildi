import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import test from "node:test";
import express from "express";

/** A235 P0 — member session must 403; empty session 401; admin not 401/403. */
const PATHS: Array<[string, string]> = [
  ["/api/schwab/oauth/start", "POST"],
  ["/api/schwab/oauth/status", "GET"],
  ["/api/schwab/oauth/complete", "POST"],
  ["/api/research/wrds/signals", "GET"],
  ["/api/research/wrds/AAPL", "GET"],
  ["/api/research/lseg/signals", "GET"],
  ["/api/research/lseg/radar", "GET"],
  ["/api/research/lseg/AAPL", "GET"],
];

/** Safe for admin smoke — clears the gate without DB/OAuth side effects. */
const ADMIN_SAFE: Array<[string, string]> = [
  ["/api/schwab/oauth/status", "GET"],
  ["/api/schwab/status", "GET"],
];

async function boot(session: Record<string, unknown>): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.DATABASE_URL ??= "postgres://ci:ci@127.0.0.1:5432/ci";
  const { default: router } = await import("./index.ts");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: Record<string, unknown> }).session = { ...session };
    next();
  });
  app.use("/api", router);
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function hit(base: string, path: string, method: string): Promise<number> {
  const res = await fetch(base + path, {
    method,
    headers: method === "POST" ? { "content-type": "application/json" } : undefined,
    body: method === "POST" ? "{}" : undefined,
    signal: AbortSignal.timeout(8_000),
  });
  return res.status;
}

test("A235 P0: anonymous 401 / member 403 / admin clears gate", async () => {
  const anon = await boot({});
  try {
    for (const [path, method] of PATHS) {
      assert.equal(await hit(anon.base, path, method), 401, `${method} ${path} anon`);
    }
  } finally {
    await anon.close();
  }

  const member = await boot({ userId: 2, role: "member" });
  try {
    for (const [path, method] of PATHS) {
      assert.equal(await hit(member.base, path, method), 403, `${method} ${path} member`);
    }
  } finally {
    await member.close();
  }

  const admin = await boot({ userId: 1, role: "admin" });
  try {
    for (const [path, method] of ADMIN_SAFE) {
      const status = await hit(admin.base, path, method);
      assert.notEqual(status, 401, `${method} ${path} admin`);
      assert.notEqual(status, 403, `${method} ${path} admin`);
    }
  } finally {
    await admin.close();
  }
});
