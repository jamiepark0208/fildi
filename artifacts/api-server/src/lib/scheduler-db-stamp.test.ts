import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FAILURE_BACKOFF_MS,
  MAX_ATTEMPTS_PER_UTC_DAY,
  nextAttemptCount,
  parseAttemptCount,
  pickFresherStamp,
  shouldRunDailyPrecomputeAt,
  shouldRunEnrichmentAt,
  shouldRunOptionScoreAt,
  shouldRunRetentionAt,
  type RunAttempt,
} from "./scheduler-catchup.ts";

const HOUR = 60 * 60 * 1000;

function attempt(at: Date, n: number): RunAttempt {
  return { lastAttempt: at, attemptsOnDay: n };
}

describe("DB stamp vs memory", () => {
  it("prefers the newer stamp, including one Maintain wrote after startup", () => {
    const memory = new Date("2026-10-16T14:00:00.000Z");
    const db = new Date("2026-10-17T14:05:00.000Z");
    assert.equal(pickFresherStamp(memory, db)?.toISOString(), db.toISOString());
    assert.equal(pickFresherStamp(db, memory)?.toISOString(), db.toISOString());
    assert.equal(pickFresherStamp(null, db)?.toISOString(), db.toISOString());
    assert.equal(pickFresherStamp(memory, new Date("not-a-date"))?.toISOString(), memory.toISOString());
  });
});

describe("attempt counter", () => {
  const now = new Date("2026-10-17T15:00:00.000Z");

  it("ignores yesterday and increments today", () => {
    assert.equal(parseAttemptCount("2026-10-16:3", now), 0);
    assert.equal(parseAttemptCount("2026-10-17:2", now), 2);
    assert.equal(nextAttemptCount("2026-10-16:3", now), "2026-10-17:1");
    assert.equal(nextAttemptCount("2026-10-17:2", now), "2026-10-17:3");
  });
});

describe("enrichment schedule is unchanged, failures back off", () => {
  it("runs Sunday 02:00 UTC when nothing has succeeded today", () => {
    assert.equal(shouldRunEnrichmentAt(null, new Date("2026-10-18T02:10:00.000Z")), true);
  });

  it("skips a weekday afternoon when the last success is recent", () => {
    const now = new Date("2026-10-14T15:00:00.000Z"); // Wednesday
    assert.equal(shouldRunEnrichmentAt(new Date("2026-10-12T02:00:00.000Z"), now), false);
  });

  it("does not run again the same UTC day Maintain already stamped", () => {
    const now = new Date("2026-10-18T02:40:00.000Z");
    assert.equal(shouldRunEnrichmentAt(new Date("2026-10-18T02:05:00.000Z"), now), false);
  });

  it("catch-up after 4 days is true, then false for 4 hours after a failure, and false after the daily cap", () => {
    const now = new Date("2026-10-17T15:00:00.000Z");
    const old = new Date("2026-10-01T02:00:00.000Z");
    assert.equal(shouldRunEnrichmentAt(old, now), true);
    assert.equal(shouldRunEnrichmentAt(old, now, attempt(new Date(now.getTime() - HOUR), 1)), false);
    assert.equal(
      shouldRunEnrichmentAt(old, now, attempt(new Date(now.getTime() - FAILURE_BACKOFF_MS - HOUR), 1)),
      true,
    );
    assert.equal(
      shouldRunEnrichmentAt(old, now, attempt(new Date(now.getTime() - FAILURE_BACKOFF_MS - HOUR), MAX_ATTEMPTS_PER_UTC_DAY)),
      false,
    );
  });
});

describe("daily precompute and retention", () => {
  it("runs at 14:00 UTC and not again after today's DB stamp", () => {
    const morning = new Date("2026-10-17T14:10:00.000Z");
    assert.equal(shouldRunDailyPrecomputeAt(null, morning), true);
    assert.equal(shouldRunDailyPrecomputeAt(new Date("2026-10-17T14:02:00.000Z"), morning), false);
  });

  it("does not retry a failed morning job 30 minutes later", () => {
    const now = new Date("2026-10-17T18:00:00.000Z");
    const old = new Date("2026-10-15T14:00:00.000Z");
    assert.equal(shouldRunDailyPrecomputeAt(old, now), true);
    assert.equal(shouldRunDailyPrecomputeAt(old, now, attempt(new Date(now.getTime() - 30 * 60 * 1000), 1)), false);
  });

  it("prunes once a day, and backs off after a failure", () => {
    const now = new Date("2026-10-17T08:00:00.000Z");
    assert.equal(shouldRunRetentionAt(null, now), true);
    assert.equal(shouldRunRetentionAt(new Date("2026-10-17T01:00:00.000Z"), now), false);
    assert.equal(shouldRunRetentionAt(new Date("2026-10-16T01:00:00.000Z"), now, attempt(new Date(now.getTime() - HOUR), 1)), false);
  });
});

describe("option score schedule is unchanged", () => {
  it("runs Monday 19:00 and never on Friday", () => {
    assert.equal(shouldRunOptionScoreAt(null, new Date("2026-10-19T19:10:00.000Z")), true);
    assert.equal(shouldRunOptionScoreAt(null, new Date("2026-10-16T19:10:00.000Z")), false);
  });

  it("catch-up backs off after a failed attempt", () => {
    const now = new Date("2026-10-14T21:00:00.000Z");
    const old = new Date("2026-10-10T19:00:00.000Z");
    assert.equal(shouldRunOptionScoreAt(old, now), true);
    assert.equal(shouldRunOptionScoreAt(old, now, attempt(new Date(now.getTime() - HOUR), 1)), false);
  });
});
