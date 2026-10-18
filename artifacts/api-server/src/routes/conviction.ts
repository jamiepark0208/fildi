/**
 * A94 — Conviction ledger API (Breakdown › Thesis). Append-only; confidence changes need a reason.
 */
import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAdmin } from "../middleware/auth.js";
import { ensureConvictionTables } from "../lib/conviction-ledger.js";

const router = Router();

router.get("/conviction/:ticker", requireAdmin, async (req, res, next) => {
  try {
    await ensureConvictionTables();
    const ticker = String(req.params.ticker || "").toUpperCase();
    const theses = (await pool.query(
      `SELECT * FROM conviction_theses WHERE ticker = $1 AND status IN ('active','proposed','killed')
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, id DESC`,
      [ticker],
    )).rows;
    const ids = theses.map((t: { id: number }) => t.id);
    let subs: unknown[] = [];
    let evidence: unknown[] = [];
    let events: unknown[] = [];
    if (ids.length) {
      subs = (await pool.query(`SELECT * FROM conviction_sub_theses WHERE thesis_id = ANY($1) ORDER BY id`, [ids])).rows;
      evidence = (await pool.query(`SELECT * FROM conviction_evidence WHERE thesis_id = ANY($1) ORDER BY id`, [ids])).rows;
      events = (await pool.query(
        `SELECT * FROM conviction_events WHERE thesis_id = ANY($1) ORDER BY created_at`,
        [ids],
      )).rows;
    }
    res.json({ ticker, theses, subs, evidence, events });
  } catch (e) {
    next(e);
  }
});

router.post("/conviction/:ticker", requireAdmin, async (req, res, next) => {
  try {
    await ensureConvictionTables();
    const ticker = String(req.params.ticker || "").toUpperCase();
    const { claim, horizon, confidence, reason, subTheses } = req.body ?? {};
    if (!claim || String(claim).length < 5) return res.status(400).json({ error: "claim (≥5 chars) required" });
    if (!reason || String(reason).length < 5) return res.status(400).json({ error: "reason (≥5 chars) required" });
    const conf = Number(confidence);
    if (!Number.isInteger(conf) || conf < 1 || conf > 5) return res.status(400).json({ error: "confidence 1–5" });
    const who = (req as { user?: { email?: string } }).user?.email ?? "admin";
    const t = (await pool.query(
      `INSERT INTO conviction_theses (ticker, claim, horizon, confidence, reason, created_by, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING *`,
      [ticker, String(claim), String(horizon || "medium"), conf, String(reason), who],
    )).rows[0];
    await pool.query(
      `INSERT INTO conviction_events (thesis_id, event, confidence, reason, created_by)
       VALUES ($1,'created',$2,$3,$4)`,
      [t.id, conf, String(reason), who],
    );
    const subsIn = Array.isArray(subTheses) ? subTheses : [];
    for (const s of subsIn) {
      if (!s?.claim || String(s.claim).length < 5) continue;
      await pool.query(
        `INSERT INTO conviction_sub_theses (thesis_id, claim, kill_rules) VALUES ($1,$2,$3::jsonb)`,
        [t.id, String(s.claim), JSON.stringify(s.killRules ?? [])],
      );
    }
    res.json({ thesis: t });
  } catch (e) {
    next(e);
  }
});

router.post("/conviction/thesis/:id/confidence", requireAdmin, async (req, res, next) => {
  try {
    await ensureConvictionTables();
    const id = Number(req.params.id);
    const { confidence, reason } = req.body ?? {};
    const conf = Number(confidence);
    if (!Number.isInteger(conf) || conf < 1 || conf > 5) return res.status(400).json({ error: "confidence 1–5" });
    if (!reason || String(reason).length < 5) return res.status(400).json({ error: "reason (≥5 chars) required" });
    const who = (req as { user?: { email?: string } }).user?.email ?? "admin";
    const t = (await pool.query(
      `UPDATE conviction_theses SET confidence = $2, reviewed_at = now() WHERE id = $1 AND status = 'active' RETURNING *`,
      [id, conf],
    )).rows[0];
    if (!t) return res.status(404).json({ error: "not found" });
    await pool.query(
      `INSERT INTO conviction_events (thesis_id, event, confidence, reason, created_by)
       VALUES ($1,'confidence',$2,$3,$4)`,
      [id, conf, String(reason), who],
    );
    res.json({ thesis: t });
  } catch (e) {
    next(e);
  }
});

router.post("/conviction/thesis/:id/kill", requireAdmin, async (req, res, next) => {
  try {
    await ensureConvictionTables();
    const id = Number(req.params.id);
    const { reason } = req.body ?? {};
    if (!reason || String(reason).length < 5) return res.status(400).json({ error: "reason (≥5 chars) required" });
    const who = (req as { user?: { email?: string } }).user?.email ?? "admin";
    const t = (await pool.query(
      `UPDATE conviction_theses SET status = 'killed', killed_at = now(), kill_note = $2 WHERE id = $1 AND status = 'active' RETURNING *`,
      [id, String(reason)],
    )).rows[0];
    if (!t) return res.status(404).json({ error: "not found" });
    await pool.query(
      `INSERT INTO conviction_events (thesis_id, event, confidence, reason, created_by)
       VALUES ($1,'killed',$2,$3,$4)`,
      [id, t.confidence, String(reason), who],
    );
    res.json({ thesis: t });
  } catch (e) {
    next(e);
  }
});

export default router;
