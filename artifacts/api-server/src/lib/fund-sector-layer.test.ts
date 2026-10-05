import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySectorLayerToScores,
  blendCompanyWithSector,
  computeRawPeerGroupOpportunity,
  rank01,
  SECTOR_LAYER_WEIGHT,
} from "./fund-sector-layer.js";

describe("fund-sector-layer", () => {
  it("exports λ=10%", () => {
    assert.equal(SECTOR_LAYER_WEIGHT, 0.1);
  });

  it("rank01 orders higher-is-better", () => {
    assert.deepEqual(rank01([10, 30, 20], true), [0, 1, 0.5]);
  });

  it("blendCompanyWithSector weights λ", () => {
    assert.equal(blendCompanyWithSector(100, 0, 0.1), 90);
    assert.equal(blendCompanyWithSector(null, 50, 0.1), null);
    assert.equal(blendCompanyWithSector(80, null, 0.1), 80);
  });

  it("large peer groups outrank speculative on size-led opportunity", () => {
    const rows = [
      { peerGroupId: "technology.big_tech_platforms", marketCap: 3e12, revenueGrowthYoY: 0.15, returnOnEquity: 0.3, peRatio: 30 },
      { peerGroupId: "technology.big_tech_platforms", marketCap: 2e12, revenueGrowthYoY: 0.12, returnOnEquity: 0.25, peRatio: 28 },
      { peerGroupId: "speculative_thematic.crypto_digital_assets", marketCap: 5e9, revenueGrowthYoY: 0.8, returnOnEquity: -0.2, peRatio: null },
      { peerGroupId: "speculative_thematic.crypto_digital_assets", marketCap: 2e9, revenueGrowthYoY: 0.5, returnOnEquity: null, peRatio: null },
    ];
    const opp = computeRawPeerGroupOpportunity(rows);
    assert.ok(
      opp.get("technology.big_tech_platforms")! >
        opp.get("speculative_thematic.crypto_digital_assets")!,
    );
  });

  it("applySectorLayerToScores lifts names in strong groups", () => {
    const rows = [
      { peerGroupId: "A.strong", marketCap: 1e12, revenueGrowthYoY: 0.2, returnOnEquity: 0.25, peRatio: 20 },
      { peerGroupId: "A.strong", marketCap: 8e11, revenueGrowthYoY: 0.18, returnOnEquity: 0.22, peRatio: 22 },
      { peerGroupId: "B.weak", marketCap: 1e9, revenueGrowthYoY: -0.1, returnOnEquity: 0.05, peRatio: 40 },
      { peerGroupId: "B.weak", marketCap: 8e8, revenueGrowthYoY: -0.05, returnOnEquity: 0.04, peRatio: 45 },
    ];
    const { blendedScores, sectorScores } = applySectorLayerToScores({
      rows,
      companyScores: [60, 60, 60, 60],
      peerGroupIds: ["A.strong", "A.strong", "B.weak", "B.weak"],
      lambda: 0.1,
    });
    assert.ok(sectorScores[0]! > sectorScores[2]!);
    assert.ok(blendedScores[0]! > blendedScores[2]!);
    assert.ok(Math.abs(blendedScores[0]! - 60) < 5);
  });
});
