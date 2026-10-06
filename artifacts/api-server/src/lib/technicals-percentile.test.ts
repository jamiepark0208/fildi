import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { percentileRank } from "./technicals-math.js";

describe("percentileRank (A25 T1 fixed window)", () => {
  it("ranks within a trailing window so extra history does not change the result", () => {
    const current = 50;
    const window = Array.from({ length: 252 }, (_, i) => 40 + (i % 20));
    window[window.length - 1] = current;
    const long = [...Array.from({ length: 400 }, () => 10), ...window];

    const a = percentileRank(current, window, 20, 252);
    const b = percentileRank(current, long, 20, 252);
    assert.ok(a != null && b != null);
    assert.equal(a, b);
  });

  it("uses only the last `window` points when series is longer", () => {
    const series = [...Array.from({ length: 100 }, () => 0), 10, 20, 30, 40, 50];
    const full = percentileRank(35, series, 5, 1000);
    const win5 = percentileRank(35, series, 5, 5);
    assert.ok(full != null && full > 0.9);
    assert.ok(win5 != null);
    assert.ok(Math.abs(win5 - 0.6) < 1e-9);
  });

  it("returns null when fewer than minN finite samples", () => {
    assert.equal(percentileRank(1, [1, 2, 3], 10), null);
  });
});
