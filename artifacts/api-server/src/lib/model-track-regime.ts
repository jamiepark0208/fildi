/**
 * A83 — regime grade stubs + multi-horizon SPY grading (from model-track-record).
 */
import { and, eq, sql, asc, gte, lte } from "drizzle-orm";
import {
  db, regimeGrades, pricesHistorical,
} from "@workspace/db";
import { fetchAndStoreOHLCV } from "./indicators.js";
import { logger } from "./logger.js";
import {
  expectedDirectionFor,
  gradeRegimeCall,
  maxDrawdownPct,
} from "./model-track-grade.js";

const NO_DATA_GRACE_DAYS = 14;

// ── Regime grade stubs ────────────────────────────────────────────────────────
// Denormalized pending rows inserted long before grading so the 90-row
// market_regime retention can't prune a call before its 12w horizon matures.
// One graded call per UTC day: the LAST market_regime row of that day.

export const REGIME_HORIZONS = [
  { horizon: "1w",  days: 7  },
  { horizon: "4w",  days: 28 },
  { horizon: "12w", days: 84 },
] as const;


export async function insertRegimeGradeStubs(): Promise<number> {
  // Last row per UTC day, via DISTINCT ON over computed_at::date.
  const rows = await db.execute<{ id: number; regime: string; confidence: number; computed_at: Date }>(sql`
    SELECT DISTINCT ON (computed_at::date) id, regime, confidence, computed_at
    FROM market_regime
    ORDER BY computed_at::date DESC, computed_at DESC
  `);
  let inserted = 0;
  for (const r of rows.rows) {
    if (r.regime === "insufficient_data") continue;
    const values = REGIME_HORIZONS.map(h => ({
      regimeRowId: r.id,
      regime: r.regime,
      confidence: r.confidence,
      classifiedAt: new Date(r.computed_at),
      horizon: h.horizon,
      expectedDirection: expectedDirectionFor(r.regime),
    }));
    const res = await db.insert(regimeGrades).values(values)
      .onConflictDoNothing({ target: [regimeGrades.regimeRowId, regimeGrades.horizon] })
      .returning({ id: regimeGrades.id });
    inserted += res.length;
  }
  return inserted;
}


// ── Grading: regime calls (multi-horizon vs SPY) ──────────────────────────────
// Pure helpers: model-track-grade.ts (expectedDirectionFor / gradeRegimeCall / maxDrawdownPct).

async function spyClosesBetween(startDate: string, endDate: string): Promise<Array<{ date: string; close: number }>> {
  const rows = await db.select({ date: pricesHistorical.date, close: pricesHistorical.close })
    .from(pricesHistorical)
    .where(and(
      eq(pricesHistorical.ticker, "SPY"),
      gte(pricesHistorical.date, startDate),
      lte(pricesHistorical.date, endDate),
    ))
    .orderBy(asc(pricesHistorical.date));
  return rows.filter(r => r.close != null).map(r => ({ date: r.date, close: Number(r.close) }));
}


export async function gradeRegimeRows(): Promise<{ graded: number; noData: number; pending: number }> {
  const now = Date.now();
  const due = await db.select().from(regimeGrades).where(eq(regimeGrades.grade, "pending"));

  let graded = 0, noData = 0, pending = 0;
  let spyFetched = false;
  for (const row of due) {
    const days = REGIME_HORIZONS.find(h => h.horizon === row.horizon)?.days ?? 28;
    const startMs = new Date(row.classifiedAt).getTime();
    const endMs = startMs + days * 86_400_000;
    if (endMs > now) { pending++; continue; } // horizon not mature yet

    try {
      const startStr = new Date(startMs).toISOString().slice(0, 10);
      const endStr = new Date(endMs).toISOString().slice(0, 10);
      let closes = await spyClosesBetween(startStr, endStr);
      if (closes.length < 2 && !spyFetched) {
        spyFetched = true; // one backfill attempt per run, not per row
        await fetchAndStoreOHLCV("SPY").catch(() => {});
        closes = await spyClosesBetween(startStr, endStr);
      }
      if (closes.length < 2) {
        if (now - endMs > NO_DATA_GRACE_DAYS * 86_400_000) {
          await db.update(regimeGrades).set({ grade: "no_data", gradedAt: new Date() }).where(eq(regimeGrades.id, row.id));
          noData++;
        } else {
          pending++;
        }
        continue;
      }

      const spyStart = closes[0]!.close;
      const spyEnd = closes[closes.length - 1]!.close;
      const fwd = (spyEnd / spyStart - 1) * 100;
      const dd = maxDrawdownPct(closes.map(c => c.close));
      const grade = gradeRegimeCall({ expectedDirection: row.expectedDirection, horizon: row.horizon, fwdReturnPct: fwd, maxDrawdownPct: dd });
      await db.update(regimeGrades).set({
        grade,
        spyStart: String(spyStart),
        spyEnd: String(spyEnd),
        fwdReturnPct: String(fwd),
        maxDrawdownPct: String(dd),
        gradedAt: new Date(),
      }).where(eq(regimeGrades.id, row.id));
      graded++;
    } catch (err) {
      logger.error({ err, gradeId: row.id }, "model-track-record: regime grading failed");
      pending++;
    }
  }
  if (due.length > 0) logger.info({ graded, noData, pending }, "model-track-record: regime grading complete");
  return { graded, noData, pending };
}

