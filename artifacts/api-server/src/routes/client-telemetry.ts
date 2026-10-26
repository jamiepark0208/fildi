/**
 * Browser → local agent bus. UI crashes land in ~/.fildi/ui-crashes.jsonl
 * (+ agent-events) so session start sees them without Sentry/Jamie relay.
 */
import { Router } from "express";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { requireAuth } from "../middleware/requireAuth.js";

const router = Router();
const DIR = join(homedir(), ".fildi");
const CRASHES = join(DIR, "ui-crashes.jsonl");
const EVENTS = join(DIR, "agent-events.jsonl");

/** Same message within 60s → drop (rapid-click spam). */
const recent = new Map<string, number>();

router.post("/client/ui-crash", requireAuth, (req, res) => {
  const body = (req.body ?? {}) as {
    message?: unknown;
    path?: unknown;
    stack?: unknown;
    source?: unknown;
  };
  const message = String(body.message ?? "").slice(0, 500).trim();
  if (!message) return res.status(400).json({ error: "message required" });

  const now = Date.now();
  const last = recent.get(message) ?? 0;
  if (now - last < 60_000) return res.json({ ok: true, deduped: true });
  recent.set(message, now);
  if (recent.size > 40) {
    for (const [k, t] of recent) {
      if (now - t > 120_000) recent.delete(k);
    }
  }

  const row = {
    t: new Date().toISOString(),
    event: "ui-crash",
    agent: "ui",
    message,
    path: String(body.path ?? "").slice(0, 200) || null,
    source: String(body.source ?? "unknown").slice(0, 40),
    stack: String(body.stack ?? "").slice(0, 1500) || null,
  };

  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(CRASHES, JSON.stringify(row) + "\n");
    appendFileSync(EVENTS, JSON.stringify(row) + "\n");
  } catch {
    /* never block the UI on log IO */
  }
  return res.json({ ok: true });
});

export default router;
