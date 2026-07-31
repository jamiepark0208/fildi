// One-shot backfill of intraday session history + checkpoint grades.
//
// Yahoo serves 5m bars roughly 60 days back, so this is a use-it-or-lose-it
// window: days that age out can never be recovered. Run it once to seed the
// Live tab's pattern panel with real history instead of waiting a quarter for
// the nightly job to accrue it.
//
// Idempotent — re-running overwrites derived stats and leaves live-recorded
// checkpoint grades intact (saveGrades refuses to downgrade a live row to a
// reconstructed one).
//
// Usage: tsx src/scripts/backfill-intraday-history.ts [days]
import {
  classifyDay,
  fetchIntradayHistory,
  saveDayStats,
  TRACKED_SYMBOLS,
} from "../lib/intraday-history.js";
import { gradeSession } from "../lib/intraday-checkpoint-grading.js";
import { logger } from "../lib/logger.js";

const DEFAULT_DAYS = 60;

async function main(): Promise<void> {
  const days = Number(process.argv[2] ?? DEFAULT_DAYS);
  if (!Number.isFinite(days) || days <= 0) throw new Error(`invalid days argument: ${process.argv[2]}`);

  const allDates = new Set<string>();

  for (const ticker of TRACKED_SYMBOLS) {
    const sessions = await fetchIntradayHistory(ticker, days);
    let saved = 0;
    let skipped = 0;

    for (const [date, bars] of sessions) {
      const stats = classifyDay(ticker, date, bars);
      // Half-days and partial feeds classify to null rather than producing a
      // dayShape that would skew every aggregate built on top of it.
      if (!stats) { skipped += 1; continue; }
      await saveDayStats(stats);
      allDates.add(date);
      saved += 1;
    }
    logger.info({ ticker, sessions: sessions.size, saved, skipped }, "backfill-intraday: sessions stored");
  }

  // Grade after ALL symbols are stored: the sweep test during reconstruction
  // reads the prior stored session, so grading mid-fetch would miss levels for
  // days not yet written.
  const sorted = [...allDates].sort();
  let graded = 0;
  let reconstructed = 0;
  for (const date of sorted) {
    try {
      const r = await gradeSession(date);
      graded += r.graded;
      reconstructed += r.reconstructed;
    } catch (err) {
      logger.warn({ err, date }, "backfill-intraday: grading failed for date");
    }
  }

  logger.info(
    { days, dates: sorted.length, first: sorted[0], last: sorted[sorted.length - 1], graded, reconstructed },
    "backfill-intraday: complete",
  );
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    logger.error({ err }, "backfill-intraday: failed");
    process.exit(1);
  });
