import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clampGrowth,
  expectedEarningsYield,
  trailingEarningsYield,
  sanitizedFcfYield,
  netCashToAssets,
  isSpeculativeThin,
  isSoftPeerSet,
  blendThree,
  applyPostScoreAdjustments,
  PEG_UNRELIABLE_FLOOR,
  SPECULATIVE_SCORE_CAP,
  CHINA_TOTAL_MULT,
  MISSING_SAFETY_PRIOR,
  EXP_EY_BLEND,
} from "./fund-score-guards.js";

describe("clampGrowth", () => {
  it("caps extreme positive and negative growth", () => {
    assert.equal(clampGrowth(9.8), 1);
    assert.equal(clampGrowth(-2), -0.8);
    assert.equal(clampGrowth(0.4), 0.4);
  });
});

describe("expectedEarningsYield", () => {
  it("prefers sane forward PE inverse", () => {
    const ey = expectedEarningsYield({
      marketCap: 100e9,
      forwardPe: 20,
      peRatio: 25,
      netIncome: 1e9,
      epsGrowth: 5,
    });
    assert.ok(ey != null && Math.abs(ey! - 0.05) < 1e-9);
  });

  it("rejects garbage ADR forward PE (<5) and falls back to 1/PE × growth", () => {
    const ey = expectedEarningsYield({
      marketCap: 11e9,
      forwardPe: 1.18, // FUTU-like junk
      peRatio: 11.42,
      netIncome: 11e9, // HKD — must NOT be used raw
      epsGrowth: 1.0,
    });
    assert.ok(ey != null);
    // 1/11.42 * 1.35 ≈ 0.118
    assert.ok(Math.abs(ey! - (1 / 11.42) * 1.35) < 1e-4);
    assert.ok(ey! < 0.25, "must not use local-currency NI/mcap");
  });

  it("nulls absurd NI/mcap when PE missing", () => {
    const ey = expectedEarningsYield({
      marketCap: 11e9,
      forwardPe: null,
      peRatio: null,
      netIncome: 11e9,
      epsGrowth: 0,
    });
    assert.equal(ey, null);
  });
});

describe("trailingEarningsYield / sanitizedFcfYield", () => {
  it("uses 1/PE when available and nulls absurd FCF yields", () => {
    assert.ok(Math.abs(trailingEarningsYield({ marketCap: 100, peRatio: 20, netIncome: 50 })! - 0.05) < 1e-9);
    assert.equal(sanitizedFcfYield({ marketCap: 10e9, freeCashFlow: 40e9 }), null); // 400% → currency mix
    assert.ok(Math.abs(sanitizedFcfYield({ marketCap: 100e9, freeCashFlow: 5e9 })! - 0.05) < 1e-9);
  });
});

describe("netCashToAssets", () => {
  it("computes (cash-debt)/assets", () => {
    assert.equal(netCashToAssets(50, 20, 100), 0.3);
    assert.equal(netCashToAssets(null, null, null), null);
    assert.equal(netCashToAssets(null, null, 100), null);
    assert.equal(netCashToAssets(30, null, 100), 0.3);
  });
});

describe("isSpeculativeThin", () => {
  it("flags speculative modes and micro revenue", () => {
    assert.equal(isSpeculativeThin({
      marketCap: 1e9, forwardPe: null, netIncome: -1e6, epsGrowth: null,
      totalRevenue: 50e6, peerGroupId: "speculative_thematic.quantum_computing",
      scoringMode: "speculative_pre_revenue",
    }), true);
    assert.equal(isSpeculativeThin({
      marketCap: 100e9, forwardPe: 20, netIncome: 10e9, epsGrowth: 0.1,
      totalRevenue: 40e9, peerGroupId: "technology.semiconductors_design",
      scoringMode: "standard",
    }), false);
  });
});

describe("isSoftPeerSet", () => {
  it("flags chinese and small peers", () => {
    assert.equal(isSoftPeerSet({
      marketCap: 10e9, forwardPe: 10, netIncome: 1e9, epsGrowth: 0.5,
      totalRevenue: 5e9, peerGroupId: "technology.chinese_tech", scoringMode: "chinese",
    }, 14), true);
    assert.equal(isSoftPeerSet({
      marketCap: 10e9, forwardPe: 10, netIncome: 1e9, epsGrowth: 0.1,
      totalRevenue: 5e9, peerGroupId: "technology.semiconductors_design", scoringMode: "standard",
    }, 17), false);
  });
});

describe("blendThree", () => {
  it("renormalizes when one leg missing", () => {
    const v = blendThree(1, null, 0, EXP_EY_BLEND);
    assert.ok(v != null);
    // peer 0.25 + universe 0.40 = 0.65 → (1*0.25 + 0*0.40)/0.65
    assert.ok(Math.abs(v! - 0.25 / 0.65) < 1e-9);
  });
});

describe("applyPostScoreAdjustments", () => {
  const baseRow = {
    marketCap: 10e9, forwardPe: 12, netIncome: 1e9, epsGrowth: 0.3,
    totalRevenue: 5e9, peerGroupId: "technology.chinese_tech", scoringMode: "chinese",
  };

  it("applies China mult and safety prior", () => {
    const out = applyPostScoreAdjustments({
      totalScore: 70,
      qualityScore: 60,
      safetyScore: null,
      safetyCoverage: 0.3,
      style: "garp",
      row: baseRow,
    });
    assert.equal(out.safetyScore, MISSING_SAFETY_PRIOR);
    assert.ok(out.totalScore != null);
    // 70*0.8 + 38*0.2 = 63.6, then * 0.90 china
    assert.ok(Math.abs(out.totalScore! - 63.6 * CHINA_TOTAL_MULT) < 0.02);
    assert.ok(out.adjustments.some((a) => a.startsWith("china_mult")));
  });

  it("caps speculative names", () => {
    const out = applyPostScoreAdjustments({
      totalScore: 66,
      qualityScore: 50,
      safetyScore: 50,
      safetyCoverage: 0.8,
      style: "growth",
      row: {
        marketCap: 5e9, forwardPe: null, netIncome: -1e8, epsGrowth: null,
        totalRevenue: 100e6, peerGroupId: "speculative_thematic.quantum_computing",
        scoringMode: "speculative_pre_revenue",
      },
    });
    assert.equal(out.totalScore, SPECULATIVE_SCORE_CAP);
  });

  it("unranks extremely thin safety", () => {
    const out = applyPostScoreAdjustments({
      totalScore: 70,
      qualityScore: 60,
      safetyScore: null,
      safetyCoverage: 0.05,
      style: "blend",
      row: {
        marketCap: 50e9, forwardPe: 15, netIncome: 5e9, epsGrowth: 0.1,
        totalRevenue: 40e9, peerGroupId: "technology.semiconductors_design",
        scoringMode: "standard",
      },
    });
    assert.equal(out.ranked, false);
    assert.equal(out.totalScore, null);
  });
});

describe("PEG floor constant", () => {
  it("is set above absurd near-zero PEGs", () => {
    assert.ok(PEG_UNRELIABLE_FLOOR >= 0.2);
  });
});
