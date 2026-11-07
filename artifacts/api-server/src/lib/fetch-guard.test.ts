import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planKey } from "./fetch-guard.js";

describe("planKey", () => {
  const sat = new Date("2026-11-07T17:00:00Z");

  it("skips when watermark is at expected session", () => {
    const p = planKey("SPY", "2026-11-06", { now: sat });
    assert.equal(p.mode, "skip");
  });

  it("tails from watermark minus overlap", () => {
    const p = planKey("SPY", "2026-11-04", { overlapDays: 2, now: sat });
    assert.equal(p.mode, "tail");
    assert.equal(p.tailFrom, "2026-11-03");
    assert.equal(p.tailTo, "2026-11-06");
  });

  it("backfill only with allowBackfill", () => {
    assert.equal(planKey("X", null).mode, "skip");
    assert.equal(planKey("X", null, { allowBackfill: true, now: sat }).mode, "backfill");
  });
});
