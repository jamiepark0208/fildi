import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assignmentStatus,
  premiumIntrinsic,
  settleWithAssignment,
  stockLegPnl,
} from "./assignment-settle.ts";

describe("premiumIntrinsic", () => {
  it("put / call ITM and OTM", () => {
    assert.equal(premiumIntrinsic("put", 100, 95), 5);
    assert.equal(premiumIntrinsic("put", 100, 105), 0);
    assert.equal(premiumIntrinsic("call", 100, 110), 10);
    assert.equal(premiumIntrinsic("call", 100, 90), 0);
  });
});

describe("stockLegPnl", () => {
  it("put long stock; call short stock", () => {
    assert.equal(stockLegPnl("put", 100, 90), -10);
    assert.equal(stockLegPnl("put", 100, 110), 10);
    assert.equal(stockLegPnl("call", 100, 90), 10);
    assert.equal(stockLegPnl("call", 100, 110), -10);
  });
});

describe("settleWithAssignment", () => {
  it("OTM put: all-in = premium, not assigned", () => {
    const s = settleWithAssignment({
      side: "put",
      strike: 100,
      premium: 2,
      window: { expiryClose: 105, closes: [] },
    });
    assert.equal(s.assigned, false);
    assert.equal(s.premiumPnlPerShare, 2);
    assert.equal(s.allInPnlPerShare, 2);
    assert.equal(assignmentStatus(s), "WIN");
  });

  it("ITM put incomplete window → ASSIGNED", () => {
    const s = settleWithAssignment({
      side: "put",
      strike: 100,
      premium: 2,
      window: { expiryClose: 95, closes: [94, 93, 92] },
    });
    assert.equal(s.assigned, true);
    assert.equal(s.windowComplete, false);
    assert.equal(s.allInPnlPerShare, null);
    assert.equal(assignmentStatus(s), "ASSIGNED");
    assert.ok(s.bestPnlPerShare != null && s.worstPnlPerShare != null);
  });

  it("ITM put day-10 close is headline (not max)", () => {
    // closes: day1..day10 — max is 108, day10 is 90
    const closes = [100, 102, 104, 106, 108, 100, 98, 96, 94, 90];
    const s = settleWithAssignment({
      side: "put",
      strike: 100,
      premium: 2,
      window: { expiryClose: 95, closes },
    });
    assert.equal(s.windowComplete, true);
    assert.equal(s.day10Close, 90);
    // all-in = premium + (day10 - strike) = 2 + (90 - 100) = -8
    assert.equal(s.allInPnlPerShare, -8);
    // best = 2 + (108 - 100) = 10
    assert.equal(s.bestPnlPerShare, 10);
    assert.equal(assignmentStatus(s), "LOSS");
    // premium-only would be 2 - 5 = -3
    assert.equal(s.premiumPnlPerShare, -3);
  });

  it("ITM call day-10 cover", () => {
    const closes = Array.from({ length: 10 }, (_, i) => 110 - i); // 110 … 101
    const s = settleWithAssignment({
      side: "call",
      strike: 100,
      premium: 3,
      window: { expiryClose: 110, closes },
    });
    assert.equal(s.day10Close, 101);
    // all-in = 3 + (100 - 101) = 2
    assert.equal(s.allInPnlPerShare, 2);
    assert.equal(assignmentStatus(s), "WIN");
  });
});
