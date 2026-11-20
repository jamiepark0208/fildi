import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { betaVsSpy, cushion, deRisk, ratioAfter } from "./book-risk.js";

describe("book-risk", () => {
  it("beta of a 2× copy of SPY is 2", () => {
    const spy = Array.from({ length: 80 }, (_, i) => ({ date: `d${String(i).padStart(3, "0")}`, close: 100 * (1 + 0.01 * Math.sin(i)) }));
    let px = 50;
    const stk = spy.map((p, i) => { if (i) px *= 1 + 2 * (p.close / spy[i - 1].close - 1); return { date: p.date, close: px }; });
    assert.ok(Math.abs(betaVsSpy(stk, spy)! - 2) < 0.05);
    assert.equal(betaVsSpy(stk.slice(0, 20), spy), null);
  });

  it("FILDI 11-20 shape: net 8.7k on 28.3k gross, beta 2.1 → SPY −3.6 % reaches the 25 % floor", () => {
    const B = 28_285 * 2.1;
    const c = cushion(8_687, 28_285, B)!;
    assert.ok(c > 0.03 && c < 0.04);
    assert.ok(Math.abs(ratioAfter(8_687, 28_285, B, -c)! - 0.25) < 1e-3);
    assert.equal(cushion(10_000, 10_000, 20_000), null);   // no loan
  });

  it("de-risk sells only what reaches the target cushion, in the given order", () => {
    const B = 28_285 * 2.1;
    const ranked = [
      { key: "a", ticker: "ONDS", what: "sell 1500 ONDS", cash: 6_000, tier: 1, why: "red", beta: 2.5 },
      { key: "b", ticker: "NVDA", what: "sell 32 NVDA", cash: 4_000, tier: 5, why: "green", beta: 1.8 },
    ];
    const r = deRisk(8_687, 28_285, B, 19_600, ranked);
    assert.equal(r.trims[0].ticker, "ONDS");
    assert.ok(r.cushionAfter! >= 0.0999);
    const last = r.trims[r.trims.length - 1];
    assert.ok(last.sell <= last.ofCash);
    assert.equal(r.reached, true);
  });
});
