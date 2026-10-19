/**
 * A83 — hotlist snapshot grading (from model-track-record).
 */
import { and, eq, sql, asc, gt } from "drizzle-orm";
import { db, hotlistSnapshots, pricesHistorical } from "@workspace/db";
import { logger } from "./logger.js";

const NO_DATA_GRACE_DAYS = 14;

// ── Grading: hotlist calls ────────────────────────────────────────────────────
// 5th trading close after snapshotDate. Dip expects a bounce (fwd > 0);
// rally expects a fade (fwd < 0).

export async function gradeHotlistSnapshots(): Promise<{ graded: number; noData: number; pending: number }> {
  const due = await db.select().from(hotlistSnapshots).where(eq(hotlistSnapshots.status, "PENDING"));

  let graded = 0, noData = 0, pending = 0;
  for (const snap of due) {
    try {
      const bars = await db.select({ close: pricesHistorical.close })
        .from(pricesHistorical)
        .where(and(eq(pricesHistorical.ticker, snap.ticker), gt(pricesHistorical.date, snap.snapshotDate)))
        .orderBy(asc(pricesHistorical.date))
        .limit(5);

      const daysPast = (Date.now() - new Date(snap.snapshotDate).getTime()) / 86_400_000;
      if (bars.length < 5 || bars[4]!.close == null) {
        if (daysPast > NO_DATA_GRACE_DAYS + 7) {
          await db.update(hotlistSnapshots).set({ status: "NO_DATA", gradedAt: new Date() }).where(eq(hotlistSnapshots.id, snap.id));
          noData++;
        } else {
          pending++; // bars not mature yet (needs ≥5 trading days + enrichment backfill)
        }
        continue;
      }

      const close5 = Number(bars[4]!.close);
      const price = Number(snap.price);
      if (!(price > 0)) { pending++; continue; }
      const fwd = (close5 / price - 1) * 100;
      const win = snap.side === "dip" ? fwd > 0 : fwd < 0;
      await db.update(hotlistSnapshots).set({
        status: win ? "WIN" : "LOSS",
        fwdReturn5d: String(fwd),
        gradedAt: new Date(),
      }).where(eq(hotlistSnapshots.id, snap.id));
      graded++;
    } catch (err) {
      logger.error({ err, snapId: snap.id, ticker: snap.ticker }, "model-track-record: hotlist grading failed");
      pending++;
    }
  }
  if (due.length > 0) logger.info({ graded, noData, pending }, "model-track-record: hotlist grading complete");
  return { graded, noData, pending };
}

