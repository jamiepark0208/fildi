import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { change, crossover, ema, highest, linreg, lowest, pivothigh, pivotlow, rma, rsi, sma, stdev, tr } from "./pine.ts";

const close = (a: number[], b: number[], eps = 1e-9) => {
  assert.equal(a.length, b.length);
  a.forEach((x, i) => {
    if (Number.isNaN(b[i]!)) assert.ok(Number.isNaN(x), `idx ${i}: want NaN got ${x}`);
    else assert.ok(Math.abs(x - b[i]!) < eps, `idx ${i}: ${x} vs ${b[i]}`);
  });
};
const N = NaN;

describe("pine primitives", () => {
  it("sma is na until n values", () => close(sma([1, 2, 3, 4, 5], 3), [N, N, 2, 3, 4]));
  it("ema seeds with the sma of the first n, then alpha 2/(n+1)", () => {
    // seed at i=2 is (1+2+3)/3 = 2; alpha 0.5 → 0.5*4+0.5*2 = 3; 0.5*5+0.5*3 = 4
    close(ema([1, 2, 3, 4, 5], 3), [N, N, 2, 3, 4]);
  });
  it("ema waits for n valid values after leading na", () => close(ema([N, N, 1, 2, 3, 4], 3), [N, N, N, N, 2, 3]));
  it("rma uses alpha 1/n with the sma seed", () => close(rma([3, 6, 9, 12], 3), [N, N, 6, (6 * 2 + 12) / 3]));
  it("stdev is biased (population)", () => {
    close(stdev([1, 2, 3], 3), [N, N, Math.sqrt(2 / 3)]);
    close(stdev([1, 2, 3], 3, false), [N, N, 1]);
  });
  it("linreg(src, n, 0) is the regression value at the last bar", () => {
    close(linreg([1, 3, 5, 7], 4), [N, N, N, 7]);
    close(linreg([1, 2, 4], 3), [N, N, 1 / 1.2 / 1.2 * 0 + (2.5 / 3 + 3)]); // intercept 0.8333 + slope 1.5 * 2
    close(linreg([1, 2, 4], 3, 1), [N, N, 2.5 / 3 + 1.5]);
  });
  it("highest / lowest / change", () => {
    close(highest([1, 5, 2, 3], 2), [N, 5, 5, 3]);
    close(lowest([4, 1, 2, 3], 3), [N, N, 1, 1]);
    close(change([1, 4, 9], 1), [N, 3, 5]);
    close(change([1, 4, 9], 2), [N, N, 8]);
  });
  it("tr is na on the first bar then the true range", () => {
    close(tr([10, 12], [9, 8], [9.5, 11]), [N, Math.max(4, 2.5, 1.5)]);
  });
  it("crossover compares a>b with a[1]<=b[1]", () => {
    assert.equal(crossover([1, 3], [2, 2], 1), true);
    assert.equal(crossover([3, 3], [2, 2], 1), false);
    assert.equal(crossover([1, 3], [N, 2], 1), false);
  });
  it("pivothigh/pivotlow confirm `right` bars late at the confirming bar", () => {
    const src = [1, 2, 5, 2, 1, 0];
    close(pivothigh(src, 2, 2), [N, N, N, N, 5, N]); // pivot bar 2, reported at bar 4
    close(pivotlow([5, 4, 1, 4, 5, 6], 2, 2), [N, N, N, N, 1, N]);
    close(pivothigh([1, 2, 5, 2, 1, 6, 1], 2, 2), [N, N, N, N, 5, N, N]);
  });
  it("rsi: all-up series is 100", () => close(rsi([1, 2, 3, 4, 5], 3), [N, N, N, 100, 100]));
});
