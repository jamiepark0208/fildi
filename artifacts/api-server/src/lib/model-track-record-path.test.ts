import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePathRisk } from "./model-track-path-risk.ts";

describe("computePathRisk", () => {
  it("put: adverse is downside; cushion used vs OTM buffer", () => {
    const r = computePathRisk({
      side: "put",
      spot: 100,
      strike: 95,
      highs: [102, 101, 100],
      lows: [99, 97, 96],
    });
    assert.ok(r);
    assert.equal(r!.maxAdversePct, 4);
    assert.equal(r!.maxFavorablePct, 2);
    assert.equal(r!.cushionUsedPct, 80);
    assert.equal(r!.pathLow, 96);
    assert.equal(r!.pathHigh, 102);
  });

  it("call: adverse is upside; cushion can exceed 100% if breached", () => {
    const r = computePathRisk({
      side: "call",
      spot: 100,
      strike: 105,
      highs: [103, 108],
      lows: [99, 100],
    });
    assert.ok(r);
    assert.equal(r!.maxAdversePct, 8);
    assert.equal(r!.cushionUsedPct, 160);
  });

  it("returns null cushion when no OTM buffer", () => {
    const r = computePathRisk({
      side: "put",
      spot: 100,
      strike: 100,
      highs: [101],
      lows: [98],
    });
    assert.ok(r);
    assert.equal(r!.cushionUsedPct, null);
    assert.equal(r!.maxAdversePct, 2);
  });
});
