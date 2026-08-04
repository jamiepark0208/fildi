// Mines already-graded intraday history to answer "does the market usually
// crash-then-recover, and does a sweep-reclaim at the open predict it" —
// pure aggregation over intradayDayStats + intradayCheckpointGrades, no new
// columns or collection needed (see plan P2a).
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { db, intradayDayStats, intradayCheckpointGrades } from "@workspace/db";

const DIGEST_TICKER = "SPY";
const EARLY_CHECKPOINT_MAX_MIN = 30; // first checkpoint at/before this is "at the open"

export interface PatternDigest {
  sessionsAnalyzed: number;
  reversalUpCount: number;
  reversalUpPct: number | null;
  medianReversalAtMin: number | null;
  sweepAtOpenCount: number;
  reversalUpGivenSweepPct: number | null;
  reversalUpGivenNoSweepPct: number | null;
  summary: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** minutes-after-open → "H:MM AM/PM PT", matching the client's CHECKPOINT_TIME_PT convention. */
function minutesToPtLabel(min: number): string {
  const openPt = 6 * 60 + 30; // 6:30 AM PT
  const total = openPt + min;
  let hour24 = Math.floor(total / 60) % 24;
  const minute = total % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period} PT`;
}

export async function getPatternDigest(sessionsBack = 20): Promise<PatternDigest> {
  const days = await db.select().from(intradayDayStats)
    .where(eq(intradayDayStats.ticker, DIGEST_TICKER))
    .orderBy(desc(intradayDayStats.date))
    .limit(sessionsBack);

  if (days.length === 0) {
    return {
      sessionsAnalyzed: 0, reversalUpCount: 0, reversalUpPct: null, medianReversalAtMin: null,
      sweepAtOpenCount: 0, reversalUpGivenSweepPct: null, reversalUpGivenNoSweepPct: null,
      summary: "Not enough graded sessions yet to detect a pattern.",
    };
  }

  const dates = days.map(d => d.date);
  const checkpoints = await db.select().from(intradayCheckpointGrades)
    .where(and(
      eq(intradayCheckpointGrades.ticker, DIGEST_TICKER),
      inArray(intradayCheckpointGrades.date, dates),
      lte(intradayCheckpointGrades.minAfterOpen, EARLY_CHECKPOINT_MAX_MIN),
    ))
    .orderBy(desc(intradayCheckpointGrades.minAfterOpen)); // last row per date wins on insert below

  // Earliest-at-open sweep flag per date: prefer the checkpoint closest to
  // EARLY_CHECKPOINT_MAX_MIN (most tape observed) if more than one qualifies.
  const sweepByDate = new Map<string, boolean>();
  for (const c of checkpoints) {
    if (sweepByDate.has(c.date)) continue;
    sweepByDate.set(c.date, c.priorDaySweep === "bullish-reclaim");
  }

  const reversalUpDays = days.filter(d => d.dayShape === "reversal-up");
  const reversalAtMins = reversalUpDays.map(d => d.reversalAtMin).filter((v): v is number => v != null);

  const withSweep = days.filter(d => sweepByDate.get(d.date) === true);
  const withoutSweep = days.filter(d => sweepByDate.has(d.date) && sweepByDate.get(d.date) === false);
  const reversalGivenSweep = withSweep.filter(d => d.dayShape === "reversal-up").length;
  const reversalGivenNoSweep = withoutSweep.filter(d => d.dayShape === "reversal-up").length;

  const reversalUpPct = reversalUpDays.length / days.length;
  const medianMin = median(reversalAtMins);
  const reversalUpGivenSweepPct = withSweep.length > 0 ? reversalGivenSweep / withSweep.length : null;
  const reversalUpGivenNoSweepPct = withoutSweep.length > 0 ? reversalGivenNoSweep / withoutSweep.length : null;

  const summaryParts: string[] = [
    `${reversalUpDays.length} of the last ${days.length} sessions opened down and reversed up (${Math.round(reversalUpPct * 100)}%)`,
  ];
  if (medianMin != null) summaryParts.push(`, typically bottoming around ${minutesToPtLabel(medianMin)}`);
  if (reversalUpGivenSweepPct != null && withSweep.length >= 3) {
    summaryParts.push(`. When a sweep-reclaim fired in the first ${EARLY_CHECKPOINT_MAX_MIN} min, reversal-up followed ${Math.round(reversalUpGivenSweepPct * 100)}% of the time (n=${withSweep.length})`);
  }

  return {
    sessionsAnalyzed: days.length,
    reversalUpCount: reversalUpDays.length,
    reversalUpPct,
    medianReversalAtMin: medianMin,
    sweepAtOpenCount: withSweep.length,
    reversalUpGivenSweepPct,
    reversalUpGivenNoSweepPct,
    summary: summaryParts.join("") + ".",
  };
}
