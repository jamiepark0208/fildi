/**
 * Rankings › Rules (Jamie 10-24: "one rules engine"; buy cheapest / sell richest on the same inputs).
 * GET /api/rankings/rules → scripts/watchlist_sync/strategy_rules.json: every input × strategy — what it wants
 * (high/low), verdict (works / fails / untested / too early / redundant), where it is live, evidence (study).
 * The file is the one home; this route only reads it (mtime cache).
 */
import { Router } from "express";
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const router = Router();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const RULES_PATH = resolve(ROOT, "scripts/watchlist_sync/strategy_rules.json");
let cache: { mtimeMs: number; body: unknown } | null = null;

router.get("/rankings/rules", (_req, res) => {
  if (!existsSync(RULES_PATH)) return res.json({ rules: null });
  const mtimeMs = statSync(RULES_PATH).mtimeMs;
  if (!cache || cache.mtimeMs !== mtimeMs) cache = { mtimeMs, body: JSON.parse(readFileSync(RULES_PATH, "utf8")) };
  return res.json({ rules: cache.body });
});

export default router;
