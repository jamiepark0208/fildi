import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  prioritizeMissingUpcoming,
  etDayKey,
  isStaleUpcomingDuplicate,
  wouldDeleteUnreportedStaleRow,
} from "./earnings-history.js";

// A240 fix-up (157b21d0 review finding 1): missingUpcoming starvation.
describe("prioritizeMissingUpcoming", () => {
  it("drops ETFs outright — they never report earnings", () => {
    const out = prioritizeMissingUpcoming(["SMH", "NEM"], {}, "2026-10-21");
    assert.deepEqual(out, ["NEM"]);
  });

  it("skips a ticker attempted empty within the last 7 ET-days", () => {
    const emptyAttempts = { BHP: "2026-10-18" }; // 3 days before "today"
    const out = prioritizeMissingUpcoming(["BHP", "NEM"], emptyAttempts, "2026-10-21");
    assert.deepEqual(out, ["NEM"]);
  });

  it("re-admits a ticker once its empty attempt is >= 7 ET-days old", () => {
    const emptyAttempts = { BHP: "2026-10-14" }; // 7 days before "today"
    const out = prioritizeMissingUpcoming(["BHP", "NEM"], emptyAttempts, "2026-10-21");
    assert.ok(out.includes("BHP"));
  });

  it("orders survivors oldest-attempt-first, never-attempted ticker first of all", () => {
    const emptyAttempts = { FCX: "2026-10-01", UPS: "2026-10-10" }; // both old enough to re-admit
    const out = prioritizeMissingUpcoming(["UPS", "FCX", "NEM"], emptyAttempts, "2026-10-21");
    // NEM was never attempted (-Infinity) — goes first; then oldest attempt (FCX) before UPS.
    assert.deepEqual(out, ["NEM", "FCX", "UPS"]);
  });
});

// A240 fix-up (157b21d0 review finding 2): UTC-vs-ET date rollover.
describe("etDayKey", () => {
  it("stays on the ET calendar day, not the already-rolled-over UTC day", () => {
    // 2026-10-22T01:00:00Z = 2026-10-21 21:00 EDT (UTC-4) — still "today" in ET,
    // but `new Date().toISOString().slice(0, 10)` would wrongly read "2026-10-22".
    const d = new Date("2026-10-22T01:00:00Z");
    assert.equal(etDayKey(d), "2026-10-21");
    assert.notEqual(etDayKey(d), d.toISOString().slice(0, 10));
  });

  it("matches the UTC day when well within ET daytime hours", () => {
    const d = new Date("2026-10-21T15:00:00Z"); // 11:00 EDT
    assert.equal(etDayKey(d), "2026-10-21");
  });
});

// A317 — dual upcoming vendor dates must not delete each other (Claude plan 2026-10-30).
describe("isStaleUpcomingDuplicate / wouldDeleteUnreportedStaleRow", () => {
  it("(a) two returned upcoming dates 1 day apart are both kept", () => {
    const returned = ["2026-11-17", "2026-11-18"];
    assert.equal(isStaleUpcomingDuplicate("2026-11-17", returned), false);
    assert.equal(isStaleUpcomingDuplicate("2026-11-18", returned), false);
  });

  it("(b) B17 regression: stale unreported row near sole returned date is deleted", () => {
    assert.equal(isStaleUpcomingDuplicate("2026-10-29", ["2026-11-02"]), true);
    assert.equal(wouldDeleteUnreportedStaleRow("2026-10-29", null, ["2026-11-02"]), true);
  });

  it("(c) reported row inside ±21d window is never a delete candidate", () => {
    assert.equal(wouldDeleteUnreportedStaleRow("2026-10-29", "1.42", ["2026-11-02"]), false);
  });

  it("(d) unreported row outside ±21d of returned upcoming is kept", () => {
    assert.equal(isStaleUpcomingDuplicate("2026-10-02", ["2026-11-02"]), false);
  });
});
