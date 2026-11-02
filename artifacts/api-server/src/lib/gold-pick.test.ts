import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pickDisputedGold } from "./gold-pick.js";

describe("pickDisputedGold", () => {
  it("on a FactSet-ruler field, cheapest source inside 20% wins over a closer expensive one", () => {
    const pick = pickDisputedGold({
      field: "forwardPe",
      factset: 10,
      free: [
        { src: "yahoo", val: 11.8 },
        { src: "finnhub", val: 10.5 },
      ],
    });
    assert.equal(pick.source, "yahoo");
    assert.equal(pick.value, 11.8);
    assert.equal(pick.divergent, false);
    assert.equal(pick.hold, false);
  });

  it("ESTC operating margin: GAAP loss cluster beats adjusted FactSet profit", () => {
    const pick = pickDisputedGold({
      field: "operatingMargin",
      factset: 0.1937,
      free: [
        { src: "yahoo", val: -0.0061 },
        { src: "finnhub", val: -0.0264 },
      ],
    });
    assert.equal(pick.source, "yahoo");
    assert.equal(pick.value, -0.0061);
    assert.equal(pick.divergent, false);
  });

  it("FROG operating margin: same-sign free losses beat FactSet even when 4pp apart", () => {
    const pick = pickDisputedGold({
      field: "operatingMargin",
      factset: 0.1826,
      free: [
        { src: "yahoo", val: -0.0712 },
        { src: "finnhub", val: -0.1152 },
      ],
    });
    assert.equal(pick.source, "yahoo");
    assert.equal(pick.value, -0.0712);
    assert.equal(pick.divergent, false);
  });

  it("keeps a signed price/earnings and does not blank either negative", () => {
    const pick = pickDisputedGold({
      field: "peRatio",
      factset: -5,
      existing: -1000000,
      free: [
        { src: "yahoo", val: -0.01 },
        { src: "finnhub", val: -1000000 },
      ],
    });
    assert.equal(pick.source, "yahoo");
    assert.equal(pick.value, -0.01);
    assert.equal(pick.divergent, true);
    assert.notEqual(pick.value, 0);
  });

  it("on a FactSet-ruler field, two agreeing free sources settle even if both miss FactSet", () => {
    const pick = pickDisputedGold({
      field: "forwardPe",
      factset: 24,
      free: [
        { src: "yahoo", val: 18 },
        { src: "finnhub", val: 18.2 },
      ],
    });
    assert.equal(pick.source, "yahoo");
    assert.equal(pick.value, 18);
    assert.equal(pick.divergent, false);
  });

  it("does not author FactSet when nothing cheap is in band on a ruler field", () => {
    const pick = pickDisputedGold({
      field: "forwardPe",
      factset: 4.16,
      existing: 8,
      free: [
        { src: "yahoo", val: 8 },
        { src: "finnhub", val: 12 },
      ],
    });
    assert.equal(pick.source, "yahoo");
    assert.equal(pick.value, 8);
    assert.equal(pick.divergent, true);
  });

  it("a stale Polygon row cannot team with EDGAR to beat a same-week Yahoo figure", () => {
    const now = Date.UTC(2026, 9, 24);
    const pick = pickDisputedGold({
      field: "totalRevenue",
      factset: 79_500_000_000,
      free: [
        { src: "yahoo", val: 72_200_000_000, pulledAt: now },
        { src: "edgar", val: 41_300_000_000, pulledAt: now },
        { src: "polygon", val: 41_300_000_000, pulledAt: now - 90 * 86_400_000 },
      ],
    });
    assert.equal(pick.source, "yahoo");
    assert.equal(pick.value, 72_200_000_000);
    assert.equal(pick.divergent, false);
  });

  it("a stale Polygon snapshot can confirm a fresh Yahoo value and does not become gold", () => {
    const now = Date.UTC(2026, 9, 24);
    const pick = pickDisputedGold({
      field: "totalRevenue",
      factset: 79_500_000_000,
      free: [
        { src: "yahoo", val: 72_200_000_000, pulledAt: now },
        { src: "polygon", val: 72_200_000_000, pulledAt: now - 90 * 86_400_000 },
      ],
    });
    assert.equal(pick.source, "yahoo");
    assert.equal(pick.value, 72_200_000_000);
    assert.equal(pick.divergent, false);
  });

  it("a sign flip between two fresh sources stays in Needs Review", () => {
    const pick = pickDisputedGold({
      field: "netIncome",
      factset: 100,
      free: [
        { src: "yahoo", val: -605_000_000 },
        { src: "finnhub", val: 269_000_000 },
      ],
    });
    assert.equal(pick.source, "yahoo");
    assert.equal(pick.value, -605_000_000);
    assert.equal(pick.divergent, true);
  });

  it("a stale FMP row can confirm a fresh EDGAR value with the same number", () => {
    const now = Date.UTC(2026, 9, 29);
    const pick = pickDisputedGold({
      field: "freeCashFlow",
      factset: -6_000_000_000,
      free: [
        { src: "yahoo", val: 22_700_000_000, pulledAt: now },
        { src: "fmp", val: 73_300_000_000, pulledAt: now - 100 * 86_400_000 },
        { src: "edgar", val: 73_300_000_000, pulledAt: now },
      ],
    });
    assert.equal(pick.source, "fmp");
    assert.equal(pick.value, 73_300_000_000);
    assert.equal(pick.divergent, false);
  });
});
