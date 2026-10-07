// Tilt is the only closed feedback loop in the app that changes what the option
// scorer recommends, so its objective function gets locked down by tests.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  tiltFactor, applyTilt, applyPolicy, TILT_MIN_N, TILT_MIN_EXPIRIES, TILT_SPAN_PNL_PCT, TILT_MAX_SHIFT,
  EMPTY_SIDE_STATS, type SideTiltStats,
} from "@workspace/option-scoring";

const stats = (o: Partial<SideTiltStats>): SideTiltStats => ({
  winRate: null, avgPnlPct: null, n: TILT_MIN_N, nExpiries: TILT_MIN_EXPIRIES, updatedAt: null, ...o,
});

describe("tiltFactor objective", () => {
  test("keys off avgPnlPct, NOT winRate", () => {
    // The regression this guards: a 90% win rate with negative expectancy must not
    // produce a positive (more-aggressive) tilt. Real 2026-08-23 call-side numbers.
    const callSide = stats({ winRate: 0.903, avgPnlPct: -0.068, n: 464 });
    assert.ok(tiltFactor(callSide) < 0, "losing money must tilt negative despite 90% wins");

    // And win rate alone carries no signal: same winRate, opposite expectancy.
    const winner = stats({ winRate: 0.903, avgPnlPct: +0.068, n: 464 });
    assert.ok(tiltFactor(winner) > 0);
    assert.equal(tiltFactor(winner), -tiltFactor(callSide));
  });

  test("break-even expectancy is neutral", () => {
    assert.equal(tiltFactor(stats({ avgPnlPct: 0, n: 100 })), 0);
  });

  test("clamps to [-1, 1] beyond the span", () => {
    assert.equal(tiltFactor(stats({ avgPnlPct: TILT_SPAN_PNL_PCT * 5, n: 100 })), 1);
    assert.equal(tiltFactor(stats({ avgPnlPct: -TILT_SPAN_PNL_PCT * 5, n: 100 })), -1);
  });

  test("no tilt below TILT_MIN_N, even with a strong signal", () => {
    assert.equal(tiltFactor(stats({ avgPnlPct: 5, n: TILT_MIN_N - 1 })), 0);
    assert.notEqual(tiltFactor(stats({ avgPnlPct: 5, n: TILT_MIN_N })), 0);
  });

  test("no tilt from one expiry week, however many recs (Oct 2026: 28 calls, 1 expiry)", () => {
    assert.equal(tiltFactor(stats({ avgPnlPct: 0.196, n: 28, nExpiries: 1 })), 0);
    assert.equal(tiltFactor(stats({ avgPnlPct: 5, n: 500, nExpiries: TILT_MIN_EXPIRIES - 1 })), 0);
    assert.equal(tiltFactor(stats({ avgPnlPct: 5, n: 500, nExpiries: undefined })), 0);
    assert.notEqual(tiltFactor(stats({ avgPnlPct: 5, n: 500 })), 0);
  });

  test("regime override also needs enough expiries", () => {
    const s = stats({ avgPnlPct: 0, n: 100, byRegime: { expansion: { n: 40, nExpiries: 2, avgPnlPct: 5 } } });
    assert.equal(applyPolicy(s, undefined, { regime: "expansion" }).factor, 0);
  });

  test("null/empty stats are neutral", () => {
    assert.equal(tiltFactor(null), 0);
    assert.equal(tiltFactor(undefined), 0);
    assert.equal(tiltFactor(EMPTY_SIDE_STATS), 0);
    // avgPnlPct null must not silently fall back to winRate
    assert.equal(tiltFactor(stats({ winRate: 0.99, avgPnlPct: null, n: 500 })), 0);
  });

  test("real 2026-08-23 state: put leans in, call backs off", () => {
    const put  = tiltFactor(stats({ winRate: 0.886, avgPnlPct: 0.102, n: 456 }));
    const call = tiltFactor(stats({ winRate: 0.903, avgPnlPct: -0.068, n: 464 }));
    assert.ok(put > 0 && put < 1, "put has positive but not maxed expectancy");
    assert.ok(call < 0, "call was losing money and must back off");
  });
});

describe("applyTilt", () => {
  test("income and buffer move in opposite directions, bounded by TILT_MAX_SHIFT", () => {
    const base = { income: 10, buffer: 10, delta: 5 };
    const { weights, factor } = applyTilt(stats({ avgPnlPct: 99, n: 100 }), base);
    assert.equal(factor, 1);
    assert.equal(weights.income, 10 * (1 + TILT_MAX_SHIFT));
    assert.equal(weights.buffer, 10 * (1 - TILT_MAX_SHIFT));
    assert.equal(weights.delta, 5, "untilted weights pass through untouched");
  });

  test("negative expectancy shifts weight toward buffer (further-OTM strikes)", () => {
    const base = { income: 10, buffer: 10 };
    const { weights } = applyTilt(stats({ avgPnlPct: -99, n: 100 }), base);
    assert.ok(weights.income < 10 && weights.buffer > 10);
  });

  test("neutral stats leave weights unchanged", () => {
    const base = { income: 10, buffer: 10 };
    const { weights, factor } = applyTilt(EMPTY_SIDE_STATS, base);
    assert.equal(factor, 0);
    assert.equal(weights.income, 10);
    assert.equal(weights.buffer, 10);
  });
});
