import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bsGreeks, normCDF } from "./options-greeks.ts";

describe("normCDF", () => {
  it("matches known points", () => {
    assert.ok(Math.abs(normCDF(0) - 0.5) < 1e-4);
    assert.ok(Math.abs(normCDF(1.96) - 0.975) < 2e-3);
    assert.ok(Math.abs(normCDF(-1.96) - 0.025) < 2e-3);
  });
});

describe("bsGreeks", () => {
  it("returns zeros for 0 DTE / bad inputs", () => {
    assert.deepEqual(bsGreeks(100, 100, 0, 0.05, 0.2, true), { delta: 0, gamma: 0, theta: 0 });
    assert.deepEqual(bsGreeks(100, 100, 0.1, 0.05, 0, true), { delta: 0, gamma: 0, theta: 0 });
    assert.deepEqual(bsGreeks(0, 100, 0.1, 0.05, 0.2, true), { delta: 0, gamma: 0, theta: 0 });
  });

  it("ATM call delta near 0.5–0.6 (r=0, σ=20%, T=1y)", () => {
    const g = bsGreeks(100, 100, 1, 0, 0.2, true);
    assert.ok(g.delta > 0.5 && g.delta < 0.6, `delta=${g.delta}`);
    assert.ok(g.gamma > 0);
    assert.ok(g.theta < 0);
  });

  it("ATM put delta ≈ call delta − 1", () => {
    const c = bsGreeks(100, 100, 1, 0, 0.2, true);
    const p = bsGreeks(100, 100, 1, 0, 0.2, false);
    assert.ok(Math.abs(p.delta - (c.delta - 1)) < 1e-6);
    assert.ok(Math.abs(p.gamma - c.gamma) < 1e-9);
  });

  it("deep ITM call delta → 1; deep OTM call delta → 0", () => {
    const itm = bsGreeks(200, 100, 0.5, 0.03, 0.25, true);
    const otm = bsGreeks(50, 100, 0.5, 0.03, 0.25, true);
    assert.ok(itm.delta > 0.95, `ITM delta=${itm.delta}`);
    assert.ok(otm.delta < 0.05, `OTM delta=${otm.delta}`);
  });
});
