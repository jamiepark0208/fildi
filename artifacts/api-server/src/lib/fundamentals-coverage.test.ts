// Coverage gating + shrinkage for fundamental family scores.
// Guards the WTR class of bug: a ticker with one non-null metric scoring 95.1 and
// ranking #1 of 558, while its other two families displayed a placeholder 50 that
// wasn't actually in the total.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  shrinkToNeutral, NEUTRAL_SCORE, FAMILY_MIN_COVERAGE, TOTAL_MIN_COVERAGE,
} from "./fundamentals-scoring-math.ts";

describe("shrinkToNeutral", () => {
  test("full coverage leaves the score untouched", () => {
    assert.equal(shrinkToNeutral(95, 1), 95);
    assert.equal(shrinkToNeutral(12, 1), 12);
  });

  test("neutral input stays neutral at any coverage", () => {
    assert.equal(shrinkToNeutral(NEUTRAL_SCORE, 1), NEUTRAL_SCORE);
    assert.equal(shrinkToNeutral(NEUTRAL_SCORE, 0.5), NEUTRAL_SCORE);
  });

  test("returns null below the family coverage floor", () => {
    assert.equal(shrinkToNeutral(95, FAMILY_MIN_COVERAGE - 0.01), null);
    assert.equal(shrinkToNeutral(95, 0), null);
    // WTR's actual quality coverage: 1 of 5 quality metrics by weight.
    assert.equal(shrinkToNeutral(95.11, 2.0 / 10.5), null);
  });

  test("at exactly the floor the score is admitted but pulled ~29% toward neutral", () => {
    const s = shrinkToNeutral(100, 0.5)!;
    assert.ok(s !== null);
    // 50 + 50*sqrt(0.5) = 85.36
    assert.ok(Math.abs(s - 85.355) < 0.01, `got ${s}`);
  });

  test("shrinkage is monotonic in coverage", () => {
    const at = (c: number) => shrinkToNeutral(100, c)!;
    assert.ok(at(0.5) < at(0.75));
    assert.ok(at(0.75) < at(1.0));
  });

  test("pulls low scores UP toward neutral, not just high scores down", () => {
    const s = shrinkToNeutral(0, 0.5)!;
    assert.ok(s > 0 && s < NEUTRAL_SCORE, `got ${s}`);
    // Symmetric with the 100 case around neutral.
    assert.ok(Math.abs((NEUTRAL_SCORE - s) - (shrinkToNeutral(100, 0.5)! - NEUTRAL_SCORE)) < 1e-9);
  });

  test("coverage above 1 is clamped, not extrapolated", () => {
    assert.equal(shrinkToNeutral(80, 1.5), 80);
  });

  test("thresholds keep their intended ordering", () => {
    assert.ok(TOTAL_MIN_COVERAGE < FAMILY_MIN_COVERAGE,
      "a ticker can be ranked on fewer families than any single family needs");
  });
});
