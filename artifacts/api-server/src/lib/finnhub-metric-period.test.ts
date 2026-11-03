import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { finnhubFieldTimelinessMs, finnhubQuarterlyOrAnnual } from "./finnhub-metric-period.js";

describe("finnhub-metric-period", () => {
  it("prefers quarterly keys for balance ratios", () => {
    const m = { currentRatioQuarterly: 7.4, currentRatioAnnual: 10.15 };
    assert.equal(finnhubQuarterlyOrAnnual(m, "currentRatioQuarterly", "currentRatioAnnual"), 7.4);
  });

  it("lags annual-only metrics in timeliness", () => {
    const pull = new Date("2026-11-02T12:00:00Z");
    const m = { currentRatioAnnual: 10.15 };
    const ms = finnhubFieldTimelinessMs(m, "currentRatio", pull);
    assert.ok(ms < pull.getTime() - 200 * 86_400_000);
  });
});
