/**
 * Model List intraday re-check (user 2026-10-11): after each newly recorded regime checkpoint in market hours, run
 * scripts/watchlist_sync/intraday.py, which re-verifies + re-publishes the Model List only when a stock moved ≥ 2σ of its
 * implied daily move, a listed contract used ≥ 50% of its cushion, or the SPY regime pause flipped. Cheap otherwise
 * (one live-price call). Mac-only: skipped when the watchlist_sync Python venv isn't present (e.g. a cloud deploy).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "./logger.js";

function findWatchlistSync(): string | null {
  // Walk up from this file (src/lib in dev, dist/ when bundled) to the repo root.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const cand = join(dir, "scripts/watchlist_sync");
    if (existsSync(join(cand, "intraday.py"))) return cand;
    dir = resolve(dir, "..");
  }
  return null;
}

let running = false;

export function runModelListIntradayCheck(): void {
  if (running) return;
  const dir = findWatchlistSync();
  const py = dir ? join(dir, ".venv/bin/python") : null;
  if (!dir || !py || !existsSync(py)) return;
  running = true;
  const child = spawn(py, ["intraday.py"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += String(d); });
  child.stderr.on("data", (d) => { out += String(d); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 15 * 60 * 1000);
  child.on("close", (code) => {
    clearTimeout(timer);
    running = false;
    const tail = out.trim().split("\n").slice(-6).join(" | ");
    if (code === 0) logger.info({ tail }, "model-list intraday check");
    else logger.warn({ code, tail }, "model-list intraday check failed");
  });
  child.on("error", (err) => {
    clearTimeout(timer);
    running = false;
    logger.warn({ err }, "model-list intraday check could not start");
  });
}
