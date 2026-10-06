import { describe, expect, it } from "vitest";
import { synthesizeStreet } from "./street-synthesis.js";

describe("synthesizeStreet", () => {
  it("flags Yahoo buy vs IBES cuts with ticker-specific text", () => {
    const s = synthesizeStreet({
      ticker: "nvda",
      yahoo: { strongBuy: 20, buy: 15, hold: 5, sell: 0, strongSell: 0, targetMean: 180, price: 150 },
      wrds: { available: true, breadth: -0.2, sue: -0.1, streetEventRisk: true },
      lseg: { available: true, targetPrice: 160, epsDrift30dPct: -3, armRank: 40 },
    });
    expect(s.tone).toBe("caution");
    expect(s.eventRisk).toBe(true);
    expect(s.conflicts.some((c) => c.code === "buy_vs_cuts")).toBe(true);
    expect(s.conflicts.find((c) => c.code === "buy_vs_cuts")!.text).toContain("NVDA");
    expect(s.conflicts.some((c) => c.code === "pt_gap")).toBe(true);
  });

  it("returns neutral with no sources", () => {
    const s = synthesizeStreet({ ticker: "AAA" });
    expect(s.tone).toBe("neutral");
    expect(s.conflicts).toHaveLength(0);
    expect(s.sources).toHaveLength(0);
  });
});
