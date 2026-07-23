import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, fetchQueue } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";
import { FETCH_FN, CALLS_PER_TICKER } from "../scripts/nightly-enrichment.js";
import { runPopulateSourceFundamentals } from "../scripts/populate-source-fundamentals.js";
import { runMergeTrusted } from "../scripts/merge-trusted.js";
import { recordApiUsage } from "../lib/api-usage.js";
import { enrichmentRunning, setEnrichmentRunning } from "../lib/scheduler.js";
import { logger } from "../lib/logger.js";

const router = Router();

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── POST /fundamentals/queue-refetch ───────────────────────────────────────────
// Queue one or more sources for ad-hoc re-fetch for a ticker+field, from the
// Stock DB tab popup. Skips sources already pending for the same ticker+field.

router.post("/fundamentals/queue-refetch", requireAdmin, async (req, res) => {
  const { ticker, field, sources } = req.body ?? {};
  if (!ticker || !field || !Array.isArray(sources) || sources.length === 0) {
    return res.status(400).json({ error: "ticker, field, and a non-empty sources array are required" });
  }
  const t = String(ticker).toUpperCase();
  const f = String(field);
  const validSources = sources.filter((s: unknown) => typeof s === "string" && s in FETCH_FN);
  if (validSources.length === 0) {
    return res.status(400).json({ error: "no valid sources given" });
  }

  try {
    const existing = await db
      .select({ source: fetchQueue.source })
      .from(fetchQueue)
      .where(and(eq(fetchQueue.ticker, t), eq(fetchQueue.field, f), eq(fetchQueue.status, "pending")));
    const already = new Set(existing.map(r => r.source));
    const toInsert = validSources.filter(s => !already.has(s));

    if (toInsert.length > 0) {
      await db.insert(fetchQueue).values(toInsert.map(source => ({ ticker: t, field: f, source })));
    }

    const queue = await db.select().from(fetchQueue)
      .where(inArray(fetchQueue.status, ["pending", "running"]));
    return res.json({ ok: true, queue });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── GET /fundamentals/queue-refetch ────────────────────────────────────────────

router.get("/fundamentals/queue-refetch", requireAdmin, async (_req, res) => {
  try {
    const queue = await db.select().from(fetchQueue)
      .where(inArray(fetchQueue.status, ["pending", "running"]))
      .orderBy(fetchQueue.queuedAt);
    return res.json({ queue });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── DELETE /fundamentals/queue-refetch/:id ─────────────────────────────────────

router.delete("/fundamentals/queue-refetch/:id", requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: "invalid id" });

  try {
    await db.delete(fetchQueue).where(and(eq(fetchQueue.id, id), eq(fetchQueue.status, "pending")));
    return res.json({ ok: true });
  } catch (err: any) {
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

// ── POST /fundamentals/queue-refetch/run ───────────────────────────────────────
// Process all pending queue rows: fetch each unique (ticker, source) pair once
// (fetch functions refetch a whole ticker's fields per source, so multiple
// queued fields for the same pair dedupe to a single call), then re-run the
// populate + merge pipeline once so ticker_fundamentals/field_provenance reflect
// the new data. Shares the scheduler's enrichmentRunning mutex so this can't
// collide with a nightly run.

router.post("/fundamentals/queue-refetch/run", requireAdmin, async (_req, res) => {
  if (enrichmentRunning) {
    return res.status(409).json({ error: "nightly enrichment is already running — try again shortly" });
  }

  const pending = await db.select().from(fetchQueue).where(eq(fetchQueue.status, "pending"));
  if (pending.length === 0) {
    return res.json({ processed: 0, ok: 0, failed: 0 });
  }

  setEnrichmentRunning(true);
  try {
    const ids = pending.map(r => r.id);
    await db.update(fetchQueue).set({ status: "running" }).where(inArray(fetchQueue.id, ids));

    const pairs = new Map<string, { ticker: string; source: string }>();
    for (const row of pending) pairs.set(`${row.ticker}:${row.source}`, { ticker: row.ticker, source: row.source });

    let okCount = 0, failCount = 0;
    const affectedTickers = new Set<string>();
    // Per-(ticker,source) outcome — a queue row's fetch job covers every field for
    // that pair at once, so all rows sharing the pair share the same outcome.
    const pairOutcome = new Map<string, "done" | "failed">();

    for (const { ticker, source } of pairs.values()) {
      const fn = FETCH_FN[source];
      const rowIds = pending.filter(r => r.ticker === ticker && r.source === source).map(r => r.id);
      try {
        const status = await fn(ticker);
        if (status === "fail") throw new Error("fetch returned fail");
        await recordApiUsage(source, CALLS_PER_TICKER[source] ?? 1).catch(() => {});
        await db.update(fetchQueue)
          .set({ status: "done", processedAt: new Date() })
          .where(inArray(fetchQueue.id, rowIds));
        okCount++;
        affectedTickers.add(ticker);
        pairOutcome.set(`${ticker}:${source}`, "done");
      } catch (err: any) {
        await db.update(fetchQueue)
          .set({ status: "failed", processedAt: new Date(), error: String(err?.message ?? err) })
          .where(inArray(fetchQueue.id, rowIds));
        failCount++;
        pairOutcome.set(`${ticker}:${source}`, "failed");
      }
      await sleep(500);
    }

    await runPopulateSourceFundamentals();
    await runMergeTrusted();

    // Per-item outcomes so the client can confirm exactly which ticker/field/source
    // jobs succeeded (and highlight them) instead of only seeing aggregate counts —
    // items disappear from GET /queue-refetch once done/failed, so this response is
    // the only place that detail is ever visible.
    const items = pending.map(r => ({
      ticker: r.ticker,
      field:  r.field,
      source: r.source,
      status: pairOutcome.get(`${r.ticker}:${r.source}`) ?? "failed",
    }));

    return res.json({ processed: pending.length, ok: okCount, failed: failCount, items });
  } catch (err: any) {
    logger.error({ err }, "queue-refetch run failed");
    return res.status(500).json({ error: String(err?.message ?? err) });
  } finally {
    setEnrichmentRunning(false);
  }
});

export default router;
