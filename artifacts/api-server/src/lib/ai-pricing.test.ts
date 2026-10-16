import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, priceKey, summarizeAiSpend } from "./ai-pricing.js";

describe("ai-pricing (A130)", () => {
  it("prices Haiku 5.5 and Haiku 4.5 per MTok", () => {
    assert.equal(estimateCostUsd("claude-haiku-5-5", 1_000_000, 1_000_000), 0.6);
    assert.equal(estimateCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000), 6);
  });
  it("strips date suffix; null/unknown model → legacy Haiku 4.5", () => {
    assert.equal(priceKey("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
    assert.equal(priceKey(null), "claude-haiku-4-5");
    assert.equal(priceKey("some-new-model"), "claude-haiku-4-5");
  });
  it("summarizes groups by surface, sorted by $", () => {
    const s = summarizeAiSpend([
      { surfaceType: "transcripts", model: "claude-haiku-5-5", calls: 10, inputTokens: 2_000_000, outputTokens: 100_000 },
      { surfaceType: "daily-brief", model: "claude-haiku-4-5-20251001", calls: 5, inputTokens: 100_000, outputTokens: 20_000 },
      { surfaceType: "transcripts", model: null, calls: 1, inputTokens: 0, outputTokens: 0 },
    ], "2026-10-01");
    assert.equal(s.calls, 16);
    assert.equal(s.inputTokens, 2_100_000);
    assert.ok(Math.abs(s.estUsd - (0.25 + 0.2)) < 1e-9);
    assert.deepEqual(s.bySurface.map(r => r.surfaceType), ["transcripts", "daily-brief"]);
    assert.equal(s.bySurface[0].calls, 11);
  });
});
