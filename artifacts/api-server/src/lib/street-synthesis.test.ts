import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { synthesizeStreet } from "./street-synthesis.js";

describe("synthesizeStreet", () => {
  it("flags Yahoo buy vs IBES cuts with ticker-specific text", () => {
    const s = synthesizeStreet({
      ticker: "nvda",
      yahoo: { strongBuy: 20, buy: 15, hold: 5, sell: 0, strongSell: 0, targetMean: 180, price: 150 },
      wrds: { available: true, breadth: -0.2, sue: -0.1, streetEventRisk: true },
      lseg: { available: true, targetPrice: 160, epsDrift30dPct: -3, armRank: 40 },
    });
    assert.equal(s.tone, "caution");
    assert.equal(s.eventRisk, true);
    assert.equal(s.conflicts.some((c) => c.code === "buy_vs_cuts"), true);
    assert.ok(s.conflicts.find((c) => c.code === "buy_vs_cuts")!.text.includes("NVDA"));
    assert.equal(s.conflicts.some((c) => c.code === "pt_gap"), true);
  });

  it("returns neutral with no sources", () => {
    const s = synthesizeStreet({ ticker: "AAA" });
    assert.equal(s.tone, "neutral");
    assert.equal(s.conflicts.length, 0);
    assert.equal(s.sources.length, 0);
  });
});
