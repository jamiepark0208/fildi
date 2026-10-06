import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { explainScoreSchema } from "./explain.ts";

// Shapes mirror the UI builders (rankings-leaderboard / technical-leaderboard), including nulls.
const fundamental = {
  ticker: "AAPL", scoreType: "fundamental",
  fundamentalData: {
    totalScore: 71.2, rank: 12, universeSize: 300,
    familyScores: { value: 40, growth: 70, quality: 85, safety: 60 },
    topMetrics: ["ROIC", "FCF margin"], weakMetrics: ["P/E"],
    reason: null, suspectMetrics: undefined,
    metricDetails: { ROIC: { value: "31%", percentile: 92, marketMedian: "9%", n: 300 } },
  },
};
const technical = {
  ticker: "TSLA", scoreType: "technical",
  technicalData: { side: "call", totalScore: 64, rank: 3, signal: "WATCH", regime: "NEUTRAL", earningsDaysOut: null, reason: "x" },
};

describe("explainScoreSchema", () => {
  it("accepts real UI payloads and keeps unlisted fields", () => {
    const f = explainScoreSchema.parse(fundamental);
    assert.equal((f.fundamentalData as Record<string, unknown>)["totalScore"], 71.2);
    const t = explainScoreSchema.parse(technical);
    assert.equal((t.technicalData as Record<string, unknown>)["side"], "call");
  });

  it("rejects oversized prompt inputs", () => {
    const bigList = { ...fundamental, fundamentalData: { ...fundamental.fundamentalData, topMetrics: Array(40).fill("m") } };
    assert.equal(explainScoreSchema.safeParse(bigList).success, false);
    const manyKeys = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`m${i}`, 1]));
    const bigRecord = { ...fundamental, fundamentalData: { ...fundamental.fundamentalData, metricValues: manyKeys } };
    assert.equal(explainScoreSchema.safeParse(bigRecord).success, false);
    assert.equal(explainScoreSchema.safeParse({ ...technical, technicalData: { reason: "x".repeat(5000) } }).success, false);
  });

  it("rejects unknown scoreType and long tickers", () => {
    assert.equal(explainScoreSchema.safeParse({ ...technical, scoreType: "options" }).success, false);
    assert.equal(explainScoreSchema.safeParse({ ...technical, ticker: "X".repeat(20) }).success, false);
  });
});
