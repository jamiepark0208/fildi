import { describe, expect, it } from "vitest";
import { trustDayPct } from "./live-format";

describe("trustDayPct (A179)", () => {
  it("flags absurd VIX-sized move outside RTH", () => {
    // Sunday 12:00 UTC ≈ Sunday morning ET
    const sunday = new Date("2026-10-25T16:00:00Z");
    const r = trustDayPct(-45, { now: sunday });
    expect(r.flagged).toBe(true);
    expect(r.text).toBe("stale");
  });

  it("keeps large move during weekday RTH", () => {
    // Tue 2026-10-27 15:00 ET = 19:00 UTC (EDT)
    const rth = new Date("2026-10-27T19:00:00Z");
    const r = trustDayPct(-45, { now: rth });
    expect(r.flagged).toBe(false);
    expect(r.text).toBe("-45%");
  });
});
