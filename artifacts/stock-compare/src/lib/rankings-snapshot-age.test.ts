import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankingsSnapshotStale, tradingDaysBehind } from "./rankings-snapshot-age.ts";

describe("rankings snapshot age (A275)", () => {
  it("Fri → Mon = 1 trading day (not stale)", () => {
    assert.equal(tradingDaysBehind("2026-10-23", "2026-10-26"), 1); // Fri→Mon
    assert.equal(rankingsSnapshotStale("2026-10-23", new Date("2026-10-26T15:00:00-04:00")), false);
  });

  it("Thu → Mon = 2 trading days (stale)", () => {
    assert.equal(tradingDaysBehind("2026-10-22", "2026-10-26"), 2); // Thu→Mon: Fri+Mon
    assert.equal(rankingsSnapshotStale("2026-10-22", new Date("2026-10-26T15:00:00-04:00")), true);
  });

  it("same day / missing", () => {
    assert.equal(tradingDaysBehind("2026-10-26", "2026-10-26"), 0);
    assert.equal(rankingsSnapshotStale(null), true);
    assert.equal(rankingsSnapshotStale("2026-10-26", new Date("2026-10-26T20:00:00-04:00")), false);
  });
});
