import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCalibrationTable,
  applyCalibrationToScore,
  scoreBucketIndex,
  walkForwardCalibration,
  CALIBRATION_HARD_SKIP_EXPECTANCY,
} from "./calibration.ts";
import {
  applyPolicy, shrinkTickerExpectancy, tiltFactor, SQ_FLOOR_BASE, SQ_FLOOR_STRICT,
} from "./tilt.ts";

describe("calibration", () => {
  it("maps scores into quintile buckets", () => {
    assert.equal(scoreBucketIndex(0), 0);
    assert.equal(scoreBucketIndex(19), 0);
    assert.equal(scoreBucketIndex(20), 1);
    assert.equal(scoreBucketIndex(99), 4);
  });

  it("haircuts negative-expectancy buckets and skips toxic ones", () => {
    const recs = [];
    for (let i = 0; i < 50; i++) {
      recs.push({ side: "put" as const, optionScore: 10, pnlPct: -0.5 });
      recs.push({ side: "put" as const, optionScore: 90, pnlPct: 0.4 });
      recs.push({ side: "call" as const, optionScore: 50, pnlPct: 0.1 });
    }
    const table = buildCalibrationTable(recs);
    assert.ok(table.put.n >= 80);
    const low = applyCalibrationToScore(10, "put", table);
    assert.equal(low.skip, true);
    assert.ok((low.bucket?.avgPnlPct ?? 0) <= CALIBRATION_HARD_SKIP_EXPECTANCY);

    const high = applyCalibrationToScore(90, "put", table);
    assert.equal(high.skip, false);
    assert.equal(high.multiplier, 1);
  });

  it("walk-forward returns holdout expectancy", () => {
    const recs = [];
    for (let d = 0; d < 10; d++) {
      const date = `2026-08-${String(d + 1).padStart(2, "0")}`;
      for (let i = 0; i < 10; i++) {
        recs.push({ side: "put" as const, optionScore: 70, pnlPct: 0.2, snapshotDate: date });
      }
    }
    const folds = walkForwardCalibration(recs, ["2026-08-08"]);
    assert.equal(folds.length, 1);
    assert.ok(folds[0]!.holdoutExpectancy.put != null);
  });
});

describe("multi-knob policy", () => {
  it("raises SQ floor when expectancy is negative", () => {
    // nExpiries ≥ TILT_MIN_EXPIRIES (8) — the tilt stays off below that (METHODS rule 9).
    const neg = applyPolicy({ winRate: 0.8, avgPnlPct: -0.4, n: 40, nExpiries: 10, updatedAt: null });
    assert.equal(neg.sqFloor, SQ_FLOOR_STRICT);
    assert.ok(neg.factor < 0);

    const pos = applyPolicy({ winRate: 0.8, avgPnlPct: 0.4, n: 40, nExpiries: 10, updatedAt: null });
    assert.equal(pos.sqFloor, SQ_FLOOR_BASE);
    assert.ok(pos.factor > 0);
  });

  it("shrinks ticker means toward global", () => {
    const shrunk = shrinkTickerExpectancy(-2, 3, 0, 12);
    // 3/(3+12)=0.2 → 0.2*-2 + 0.8*0 = -0.4
    assert.ok(Math.abs(shrunk - -0.4) < 1e-9);
  });

  it("returns zero tilt below min N", () => {
    assert.equal(tiltFactor({ winRate: 1, avgPnlPct: 1, n: 5, updatedAt: null }), 0);
  });
});
