import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BREADTH_DROP_PP,
  BREADTH_LOOKBACK_BARS,
  breadthChg30,
  isBreadthDrop,
} from "./intraday-breadth-drop.js";

describe("breadth drop rule (A314 / S143)", () => {
  it("fires at ≥8pp fall over 6 completed bars", () => {
    const hist = [0.55, 0.54, 0.53, 0.52, 0.51, 0.50, 0.47];
    assert.equal(hist.length, BREADTH_LOOKBACK_BARS + 1);
    const chg = breadthChg30(hist);
    assert.ok(chg != null && chg <= -BREADTH_DROP_PP);
    assert.equal(isBreadthDrop(chg), true);
  });

  it("does not fire at 7pp fall", () => {
    const hist = [0.55, 0.54, 0.53, 0.52, 0.51, 0.50, 0.48];
    const chg = breadthChg30(hist)!;
    assert.ok(chg > -BREADTH_DROP_PP);
    assert.equal(isBreadthDrop(chg), false);
  });

  it("does not fire with fewer than 6 lookback bars", () => {
    const hist = [0.6, 0.5, 0.4, 0.3, 0.2, 0.1];
    assert.equal(hist.length, BREADTH_LOOKBACK_BARS);
    assert.equal(breadthChg30(hist), null);
    assert.equal(isBreadthDrop(null), false);
  });
});
