import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BREADTH_DROP_PP,
  BREADTH_CHG30_MS,
  breadthChg30,
  isBreadthDrop,
} from "./intraday-breadth-drop.js";

describe("breadth drop rule (A314 / S143)", () => {
  it("fires at ≥8pp fall over 30 minutes", () => {
    const t1 = 0;
    const t2 = t1 + BREADTH_CHG30_MS;
    const series = [
      { tsMs: t1, aboveVwap: 0.55 },
      { tsMs: t2, aboveVwap: 0.47 },
    ];
    const chg = breadthChg30(series);
    assert.ok(chg != null && chg <= -BREADTH_DROP_PP);
    assert.equal(isBreadthDrop(chg), true);
  });

  it("does not fire at 7pp fall", () => {
    const t1 = 0;
    const t2 = t1 + BREADTH_CHG30_MS;
    const chg = breadthChg30([
      { tsMs: t1, aboveVwap: 0.55 },
      { tsMs: t2, aboveVwap: 0.48 },
    ])!;
    assert.ok(chg > -BREADTH_DROP_PP);
    assert.equal(isBreadthDrop(chg), false);
  });

  it("returns null when no row within ±2 min of ts−30m (gap / missed poll)", () => {
    const latest = 5 * BREADTH_CHG30_MS;
    const series = [
      { tsMs: 0, aboveVwap: 0.9 },
      { tsMs: latest, aboveVwap: 0.1 },
    ];
    assert.equal(breadthChg30(series), null);
    assert.equal(isBreadthDrop(null), false);
  });
});
