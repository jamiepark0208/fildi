import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normCdf, probabilityCone, putStrikeOdds, daysTo } from "./prob-cone.ts";

describe("normCdf", () => {
  it("matches table values", () => {
    assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
    assert.ok(Math.abs(normCdf(-1) - 0.158655) < 1e-5);
    assert.ok(Math.abs(normCdf(1.96) - 0.975002) < 1e-5);
  });
});

describe("probabilityCone", () => {
  // 2026-11-10 is a Tuesday.
  const start = Date.parse("2026-11-10T00:00:00Z") / 1000;
  it("1σ at 365 d with 40 % IV = exp(±0.4)", () => {
    const c = probabilityCone(100, 0.4, start, 365)!;
    const last = c.up1[c.up1.length - 1]!;
    // last weekday ≤ 365 d out; check the 1σ formula on its own day count
    const d = (last.time - start) / 86_400;
    assert.ok(Math.abs(last.value - 100 * Math.exp(0.4 * Math.sqrt(d / 365))) < 1e-9);
    assert.ok(c.dn2[c.dn2.length - 1]!.value < c.dn1[c.dn1.length - 1]!.value);
  });
  it("starts at spot and skips weekends", () => {
    const c = probabilityCone(50, 0.5, start, 7)!;
    assert.equal(c.up1[0]!.value, 50);
    assert.equal(c.up1.length, 1 + 5); // Wed..Fri, Mon, Tue
    for (const p of c.up1.slice(1)) {
      const dow = new Date(p.time * 1000).getUTCDay();
      assert.ok(dow !== 0 && dow !== 6);
    }
  });
  it("rejects bad inputs", () => {
    assert.equal(probabilityCone(0, 0.4, start, 30), null);
    assert.equal(probabilityCone(100, 0, start, 30), null);
  });
});

describe("putStrikeOdds", () => {
  it("strike 1σ below spot → ~16 % below, ~32 % touch", () => {
    const iv = 0.5, days = 30;
    const s = iv * Math.sqrt(days / 365);
    const o = putStrikeOdds(100, 100 * Math.exp(-s), iv, days)!;
    assert.ok(Math.abs(o.sigmas - 1) < 1e-9);
    assert.ok(Math.abs(o.pBelow - 0.1587) < 1e-3);
    assert.ok(Math.abs(o.pTouch - 0.3173) < 2e-3);
  });
  it("ITM strike → negative σ, P(below) > 50 %", () => {
    const o = putStrikeOdds(100, 110, 0.4, 20)!;
    assert.ok(o.sigmas < 0 && o.pBelow > 0.5 && o.pTouch === 1);
  });
});

describe("daysTo", () => {
  it("counts to expiry close", () => {
    const d = daysTo("2026-11-20", new Date("2026-11-10T21:00:00Z"));
    assert.equal(d, 10);
  });
});
