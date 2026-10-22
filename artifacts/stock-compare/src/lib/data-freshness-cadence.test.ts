import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { approxTradingDayLag, cadenceClause } from "./data-freshness-cadence.ts";

describe("data-freshness-cadence A215", () => {
  it("fresh when within max lag", () => {
    const today = new Date().toISOString();
    const c = cadenceClause(today, "fund_score");
    assert.ok(c?.startsWith("fresh"), c ?? "");
  });

  it("flags behind when older than max", () => {
    const old = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const c = cadenceClause(old, "fund_score");
    assert.ok(c && /trading days behind/.test(c), c ?? "");
  });

  it("approx lag is non-negative", () => {
    assert.equal(approxTradingDayLag(new Date().toISOString()), 0);
    assert.ok((approxTradingDayLag(new Date(Date.now() - 7 * 86_400_000).toISOString()) ?? -1) >= 0);
  });
});
