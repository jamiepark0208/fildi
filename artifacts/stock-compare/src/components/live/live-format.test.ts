import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { trustDayPct } from "./live-format.ts";

describe("trustDayPct (A179)", () => {
  it("flags absurd VIX-sized move outside RTH", () => {
    // Sunday 12:00 UTC ≈ Sunday morning ET
    const sunday = new Date("2026-10-25T16:00:00Z");
    const r = trustDayPct(-45, { now: sunday });
    assert.equal(r.flagged, true);
    assert.equal(r.text, "stale");
  });

  it("keeps large move during weekday RTH", () => {
    // Tue 2026-10-27 15:00 ET = 19:00 UTC (EDT)
    const rth = new Date("2026-10-27T19:00:00Z");
    const r = trustDayPct(-45, { now: rth });
    assert.equal(r.flagged, false);
    assert.equal(r.text, "-45%");
  });

  it("does not ×100 small Yahoo percent points (SPY +0.21%)", () => {
    const rth = new Date("2026-10-27T19:00:00Z");
    const r = trustDayPct(0.21, { now: rth });
    assert.equal(r.flagged, false);
    assert.equal(r.text, "—"); // rounds to 0 → flat
  });
});
