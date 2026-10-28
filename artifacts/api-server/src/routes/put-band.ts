/**
 * Sold-put delta band setting (Jamie 10-28: "allow me to set the delta band dynamically").
 * GET /api/strategies/put-band → { pref, bands, computedAt } — pref = watchlist_sync.user_prefs 'put_band'
 *   ({mode: "auto"} band engine · {mode: "shift", steps: -3..3} closer (+) / farther (−) · {mode: "fixed", band}).
 * PUT /api/strategies/put-band {pref} → saves it, reruns put_recs.py (~4 s) so every surface reading put_recs_daily
 *   picks it up; Model List takes it at its next publish. Bands above 0.20Δ refused (S071 cap); panic pause still applies.
 */
import { Router } from "express";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger.js";

const router = Router();
const WS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../scripts/watchlist_sync");

function bands(): string[] {
  const rules = JSON.parse(readFileSync(join(WS, "strategy_rules.json"), "utf8"));
  return (rules.engine.strategies.sell_put.strike.bands as string[]).filter((b) => Number(b.split("-")[1]) <= 0.2 + 1e-9);
}

async function ensure(): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS watchlist_sync.user_prefs (key text PRIMARY KEY, value jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now())`);
}

function rerunPutRecs(): Promise<{ ok: boolean; tail: string }> {
  const py = join(WS, ".venv/bin/python");
  if (!existsSync(py)) return Promise.resolve({ ok: false, tail: "watchlist_sync venv missing (Mac only)" });
  return new Promise((done) => {
    const child = spawn(py, ["put_recs.py"], { cwd: WS, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => child.kill("SIGTERM"), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = out.trim().split("\n").slice(-2).join(" | ");
      if (code !== 0) logger.warn({ code, tail }, "put-band: put_recs rerun failed");
      done({ ok: code === 0, tail });
    });
    child.on("error", (err) => { clearTimeout(timer); done({ ok: false, tail: String(err) }); });
  });
}

router.get("/strategies/put-band", async (_req, res) => {
  await ensure();
  const { rows } = await pool.query(`SELECT value, updated_at FROM watchlist_sync.user_prefs WHERE key = 'put_band'`);
  const { rows: rc } = await pool.query(`SELECT MAX(computed_at) AS c FROM watchlist_sync.put_recs_daily`).catch(() => ({ rows: [{ c: null }] }));
  res.json({ pref: rows[0]?.value ?? { mode: "auto" }, updatedAt: rows[0]?.updated_at ?? null, bands: bands(), computedAt: rc[0]?.c ?? null });
});

router.put("/strategies/put-band", async (req, res) => {
  const p = req.body?.pref ?? {};
  let pref: Record<string, unknown>;
  if (p.mode === "auto") pref = { mode: "auto" };
  else if (p.mode === "shift" && Number.isInteger(p.steps) && Math.abs(p.steps) <= 3) pref = { mode: "shift", steps: p.steps };
  else if (p.mode === "fixed" && bands().includes(p.band)) pref = { mode: "fixed", band: p.band };
  else return res.status(400).json({ error: `pref must be {mode:"auto"} · {mode:"shift",steps:-3..3} · {mode:"fixed",band:one of ${bands().join(", ")}}` });
  await ensure();
  await pool.query(`INSERT INTO watchlist_sync.user_prefs (key, value) VALUES ('put_band', $1::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(pref)]);
  const run = await rerunPutRecs();
  return res.json({ pref, rerun: run });
});

export default router;
