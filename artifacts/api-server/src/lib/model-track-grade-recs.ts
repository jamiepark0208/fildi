/**
 * A83 — option rec grading + assignment settle (from model-track-record).
 */
import { and, eq, sql, lte } from "drizzle-orm";
import { db, modelRecs } from "@workspace/db";
import { closeOnOrBeforeExpiryChecked } from "./trade-post-expiry.js";
import { fetchAndStoreOHLCV } from "./indicators.js";
import { logger } from "./logger.js";
import { settleRec } from "./model-track-grade.js";
import {
  assignmentStatus,
  settleWithAssignment,
  type AssignmentSide,
} from "./assignment-settle.js";
import { pathRiskForRec, closesAfterExpiry } from "./model-track-bars.js";
import { etDateKey } from "./market-hours.js";

const NO_DATA_GRACE_DAYS = 14;
const SPLIT_GUARD_MOVE = 0.6;

function todayStr(): string {
  return etDateKey(); // ET market date (was UTC: rolled to tomorrow after 5 PM PT, 10-20)
}

// ── Grading: option recs ──────────────────────────────────────────────────────
// Settle-at-expiry from stock closes (no historical option prices exist):
// put intrinsic = max(strike - close, 0); call = max(close - strike, 0).
// pnlPerShare = premium - intrinsic (we always model SELL). WIN iff > 0.
// pnlPct basis: put → strike (cash-secured collateral); call → spot (covered stock).


export async function gradeModelRecs(): Promise<{ graded: number; noData: number; pending: number; assigned: number }> {
  // PENDING = never settled; ASSIGNED = ITM waiting day-10; also regrade old ITM
  // WIN/LOSS missing `_settlement.assignment` (A92 backfill).
  const due = await db.select().from(modelRecs)
    .where(and(
      sql`(
        ${modelRecs.status} IN ('PENDING','ASSIGNED')
        OR (
          ${modelRecs.status} IN ('WIN','LOSS')
          AND COALESCE(${modelRecs.intrinsic}::float8, 0) > 0
          AND (${modelRecs.componentScores}->'_settlement'->'assignment') IS NULL
        )
      )`,
      // lte (11-10): the Fri-evening run skipped same-day expiries → a week of ungraded recs. Same-day rows settle only once
      // that day's close is stored (guard below).
      lte(modelRecs.expiry, todayStr()),
    ));

  let graded = 0, noData = 0, pending = 0, assigned = 0;
  for (const rec of due) {
    try {
      let hit = await closeOnOrBeforeExpiryChecked(rec.ticker, rec.expiry);
      const sameDay = rec.expiry === todayStr();
      if (hit == null || (sameDay && hit.date !== rec.expiry)) {
        await fetchAndStoreOHLCV(rec.ticker).catch(() => {});
        hit = await closeOnOrBeforeExpiryChecked(rec.ticker, rec.expiry);
      }
      if (sameDay && hit?.date !== rec.expiry) { pending++; continue; } // expiry-day close not in yet
      let close = hit?.close ?? null;

      const daysPast = (Date.now() - new Date(rec.expiry).getTime()) / 86_400_000;
      const spot = Number(rec.spot);
      // Split guard: Yahoo backfills split-adjusted closes, which would corrupt
      // strike-vs-close settlement — a >60% "move" with huge intrinsic is far more
      // likely a split than a real crash/melt-up. Same limitation as trade-post-expiry.
      const looksLikeSplit = close != null && spot > 0 && Math.abs(close / spot - 1) > SPLIT_GUARD_MOVE;

      if (close == null || looksLikeSplit) {
        if (looksLikeSplit || daysPast > NO_DATA_GRACE_DAYS) {
          await db.update(modelRecs).set({ status: "NO_DATA", gradedAt: new Date() }).where(eq(modelRecs.id, rec.id));
          noData++;
          if (looksLikeSplit) logger.warn({ ticker: rec.ticker, recId: rec.id, spot, close }, "model-track-record: split-like move, marked NO_DATA");
        } else {
          pending++; // retry next week
        }
        continue;
      }

      const s = settleRec({ side: rec.side, strike: Number(rec.strike), spot, premium: Number(rec.premium), close });
      const side = (rec.side === "call" ? "call" : "put") as AssignmentSide;
      let postCloses = await closesAfterExpiry(rec.ticker, rec.expiry, 10);
      if (postCloses.length < 10) {
        await fetchAndStoreOHLCV(rec.ticker).catch(() => {});
        postCloses = await closesAfterExpiry(rec.ticker, rec.expiry, 10);
      }
      const a = settleWithAssignment({
        side,
        strike: Number(rec.strike),
        premium: Number(rec.premium),
        window: { expiryClose: close, closes: postCloses },
      });
      const finalStatus = assignmentStatus(a);
      const basis = side === "put" ? Number(rec.strike) : spot;
      // Headline columns: all-in when window complete; premium while ASSIGNED/OTM.
      const headlinePnl = a.allInPnlPerShare ?? a.premiumPnlPerShare;
      const headlinePct = basis > 0 ? (headlinePnl / basis) * 100 : 0;

      const prevComponents = (rec.componentScores && typeof rec.componentScores === "object")
        ? rec.componentScores as Record<string, unknown>
        : {};
      const path = await pathRiskForRec({
        ticker: rec.ticker,
        side: rec.side,
        spot,
        strike: Number(rec.strike),
        snapshotDate: rec.snapshotDate,
        endDate: rec.expiry,
      });
      await db.update(modelRecs).set({
        status: finalStatus,
        settleClose: String(close),
        intrinsic: String(s.intrinsic),
        pnlPerShare: String(headlinePnl),
        pnlPct: String(headlinePct),
        componentScores: {
          ...prevComponents,
          _settlement: {
            hold: { pnlPct: s.pnlPct, status: s.status, pnlPerShare: s.pnlPerShare },
            managed: {
              pnlPct: s.managedPnlPct,
              status: s.managedStatus,
              pnlPerShare: s.managedPnlPerShare,
              rule: "take_50pct_credit_or_stop_2x",
            },
            assignment: {
              assigned: a.assigned,
              windowComplete: a.windowComplete,
              windowDays: a.windowDays,
              day10Close: a.day10Close,
              stockPnlPerShare: a.stockPnlPerShare,
              premiumPnlPerShare: a.premiumPnlPerShare,
              allInPnlPerShare: a.allInPnlPerShare,
              bestPnlPerShare: a.bestPnlPerShare,
              worstPnlPerShare: a.worstPnlPerShare,
              rule: "day10_close_after_expiry",
              status: finalStatus,
            },
          },
          ...(path ? { _pathRisk: path } : {}),
        },
        gradedAt: new Date(),
      }).where(eq(modelRecs.id, rec.id));
      if (finalStatus === "ASSIGNED") assigned++;
      else graded++;
    } catch (err) {
      logger.error({ err, recId: rec.id, ticker: rec.ticker }, "model-track-record: rec grading failed");
      pending++;
    }
  }
  if (due.length > 0) logger.info({ graded, noData, pending, assigned }, "model-track-record: rec grading complete");
  return { graded, noData, pending, assigned };
}

