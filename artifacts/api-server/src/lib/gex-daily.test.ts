import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeGammaFlip, computeGexSummary, contractGexDollars } from "./gex-daily-math.js";

describe("gex-daily", () => {
  it("sums GEX on a 3-contract fixture (gex-tracker scaling)", () => {
    const spot = 100;
    const c1 = contractGexDollars(0.01, 50, spot, true);
    const c2 = contractGexDollars(0.02, 30, spot, true);
    const p1 = contractGexDollars(0.01, 40, spot, false);
    assert.equal(c1, 0.01 * 50 * 100 * spot * spot * 0.01);
    assert.equal(c2, 0.02 * 30 * 100 * spot * spot * 0.01);
    assert.equal(p1, -(0.01 * 40 * 100 * spot * spot * 0.01));

    const iv = 0.25;
    const dte = 30;
    const s = computeGexSummary(
      [
        { strike: 100, side: "call", gamma: 0.01, openInterest: 50, iv, dte },
        { strike: 105, side: "call", gamma: 0.02, openInterest: 30, iv, dte },
        { strike: 95, side: "put", gamma: 0.01, openInterest: 40, iv, dte },
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

  it("gamma flip from hypothetical-spot grid (2-contract fixture)", () => {
    const spot = 100;
    const iv = 0.3;
    const dte = 45;
    const contracts = [
      { strike: 100, side: "call" as const, gamma: 0.05, openInterest: 5000, iv, dte },
      { strike: 100, side: "put" as const, gamma: 0.05, openInterest: 5000, iv, dte },
    ];
    assert.equal(computeGammaFlip(contracts, spot), 100);
    const summary = computeGexSummary(contracts, spot);
    assert.equal(summary.gammaFlip, 100);
  });
});
