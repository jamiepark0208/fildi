import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { holdLevel, type RiskCall, type RiskLevel } from "./intraday-risk.js";

const call = (level: RiskLevel): RiskCall => ({ level, score: 0, pDropHalfAtr: 0, halfAtrPct: 1, state: "range",
  inputs: { rngRel: 1, ret5d: 0, er: 0.3, chop: 50, atr20: 0.01 } });

describe("holdLevel (Live buffer)", () => {
  it("shows a step up at once", () => {
    assert.equal(holdLevel(call("stormy"), call("elevated"), "elevated").level, "stormy");
  });
  it("holds a one-bar step down (10-29 07:17 stormy→elevated→stormy flicker)", () => {
    assert.equal(holdLevel(call("elevated"), call("stormy"), "stormy").level, "stormy");
  });
  it("accepts a step down confirmed by the previous bar", () => {
    const r = holdLevel(call("elevated"), call("elevated"), "stormy");
    assert.equal(r.level, "elevated");
  });
  it("first call of the day passes through", () => {
    assert.equal(holdLevel(call("normal"), null, null).level, "normal");
  });
});
