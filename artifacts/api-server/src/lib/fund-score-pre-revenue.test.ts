import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assignStyleBucket } from "./fund-score-style.js";
import type { FundRowInput } from "./fund-score-types.js";

function row(over: Partial<FundRowInput>): FundRowInput {
  return { ticker: "X", netIncome: 1_000, totalRevenue: 5_000_000_000, peerGroupId: null, scoringMode: null, ...over } as FundRowInput;
}

describe("isEconomicallyPreRevenue", () => {
  it("treats missing revenue as unknown, not pre-revenue (non-USD ADRs like TSM)", () => {
    assert.notEqual(assignStyleBucket(row({ totalRevenue: null, netIncome: null }), 0.5, 0.5), "pre_revenue");
  });
  it("still flags zero or tiny loss-making revenue", () => {
    assert.equal(assignStyleBucket(row({ totalRevenue: 0 }), 0.5, 0.5), "pre_revenue");
    assert.equal(assignStyleBucket(row({ totalRevenue: 10_000_000, netIncome: -5_000_000 }), 0.5, 0.5), "pre_revenue");
  });
});
