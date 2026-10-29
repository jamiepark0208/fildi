import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ema, isTrendFall } from "./intraday-trend-fall.js";

describe("isTrendFall", () => {
  it("fires when EMA12 falls more than 0.15 % over 3 bars", () => {
    assert.equal(isTrendFall([...Array(12).fill(100), 99.6, 99.2, 98.8]), true);
  });
  it("stays off on a flat tape", () => {
    assert.equal(isTrendFall(Array(20).fill(100)), false);
  });
  it("needs 12 bars before it can fire", () => {
    assert.equal(isTrendFall([100, 100, 99, 98, 97]), false);
  });
  it("ema seeds on the first value", () => {
    assert.deepEqual(ema([10, 10, 10]), [10, 10, 10]);
  });
});
