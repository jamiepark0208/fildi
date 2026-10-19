import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { brierScore, shrinkToChance } from "./figure-views.js";

describe("A85 Brier helpers", () => {
  it("perfect forecast scores 0", () => {
    assert.equal(brierScore(1, true), 0);
    assert.equal(brierScore(0, false), 0);
  });
  it("coin-flip is 0.25", () => {
    assert.equal(brierScore(0.5, true), 0.25);
  });
  it("shrinks hit rate toward 50%", () => {
    const s = shrinkToChance(1, 2, 8);
    assert.ok(s < 1 && s > 0.5);
    assert.ok(Math.abs(s - (2 * 1 + 8 * 0.5) / 10) < 1e-9);
  });
});
