import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calendarDaysUntil,
  calendarDaysUntilYmd,
  daysUntilCeil,
  daysUntilCeilNonNeg,
  exactDaysUntil,
  settlementOffsetDays,
} from "./date-util.ts";

describe("exactDaysUntil / daysUntilCeil", () => {
  it("returns 0 for non-Date (options semantics)", () => {
    assert.equal(exactDaysUntil("2026-01-01"), 0);
    assert.equal(daysUntilCeil(null), 0);
  });

  it("future Date is positive; past is negative for ceil path", () => {
    const future = new Date(Date.now() + 2.5 * 86_400_000);
    const past = new Date(Date.now() - 1.2 * 86_400_000);
    assert.ok(exactDaysUntil(future) > 2);
    assert.ok(daysUntilCeil(future) >= 3);
    assert.ok(daysUntilCeil(past) <= -1);
    assert.equal(daysUntilCeilNonNeg(past), 0);
  });
});

describe("calendarDaysUntil", () => {
  it("parses date-only at noon", () => {
    const iso = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const n = calendarDaysUntil(iso);
    assert.ok(n >= 9 && n <= 11, `got ${n}`);
  });
});

describe("calendarDaysUntilYmd", () => {
  it("matches midnight-to-midnight rounding", () => {
    // local date, not UTC: toISOString() is tomorrow after 5 PM PT and made this fail every evening (10-20)
    const iso = new Date().toLocaleDateString("en-CA");
    assert.equal(calendarDaysUntilYmd(iso), 0);
  });
});

describe("settlementOffsetDays", () => {
  it("Fri → 3, Mon → 1", () => {
    // 2026-10-16 was a Friday
    assert.equal(settlementOffsetDays(new Date("2026-10-16T16:00:00")), 3);
    assert.equal(settlementOffsetDays(new Date("2026-10-12T16:00:00")), 1); // Mon
  });
});
