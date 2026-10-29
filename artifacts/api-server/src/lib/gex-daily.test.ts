import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeGexSummary, contractGexDollars } from "./gex-daily-math.js";

describe("gex-daily", () => {
  it("sums GEX on a 3-contract fixture (gex-tracker scaling)", () => {
    const spot = 100;
    const c1 = contractGexDollars(0.01, 50, spot, true);
    const c2 = contractGexDollars(0.02, 30, spot, true);
    const p1 = contractGexDollars(0.01, 40, spot, false);
    assert.equal(c1, 0.01 * 50 * 100 * spot * spot * 0.01);
    assert.equal(c2, 0.02 * 30 * 100 * spot * spot * 0.01);
    assert.equal(p1, -(0.01 * 40 * 100 * spot * spot * 0.01));

    const s = computeGexSummary(
      [
        { strike: 100, side: "call", gamma: 0.01, openInterest: 50 },
        { strike: 105, side: "call", gamma: 0.02, openInterest: 30 },
        { strike: 95, side: "put", gamma: 0.01, openInterest: 40 },
      ],
      spot,
    );
    assert.equal(s.callGex, c1 + c2);
    assert.equal(s.putGex, p1);
    assert.equal(s.netGex, c1 + c2 + p1);
    assert.equal(s.nContracts, 3);
    assert.equal(s.callWall, 105);
    assert.equal(s.putWall, 95);
  });
});
