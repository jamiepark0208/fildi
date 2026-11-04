import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resample } from "./resample.ts";
import type { TvBar } from "./types.ts";

const mk = (utcMs: number, n: number): TvBar[] =>
  Array.from({ length: n }, (_, k) => ({
    time: utcMs / 1000 + k * 300, open: 100 + k, high: 101 + k, low: 99 + k, close: 100.5 + k, volume: 10 + k,
  }));

describe("resample", () => {
  // 2026-11-04 is EST: 09:30 ET = 14:30Z. 24 bars = 09:30 .. 11:25.
  const est = mk(Date.UTC(2026, 10, 4, 14, 30), 25); // 25th bar = 11:30 → lone bar in the 3rd hour bucket
  it("1h buckets anchor at 09:30 ET, keep the last partial bucket", () => {
    const h = resample(est, 60);
    assert.equal(h.length, 3);
    assert.equal(h[0]!.time, est[0]!.time);
    assert.equal(h[1]!.time, est[12]!.time); // 10:30 ET
    assert.equal(h[2]!.n, 1);
    assert.equal(h[0]!.n, 12);
    assert.equal(h[0]!.end - est[0]!.time, 3600);
    assert.equal(h[0]!.open, 100);
    assert.equal(h[0]!.close, 100.5 + 11);
    assert.equal(h[0]!.high, 101 + 11);
    assert.equal(h[0]!.low, 99);
    assert.equal(h[0]!.volume, Array.from({ length: 12 }, (_, k) => 10 + k).reduce((a, b) => a + b));
    assert.equal(h[0]!.lastTime, est[11]!.time);
  });
  it("15m buckets are 3 bars each", () => {
    const q = resample(est.slice(0, 9), 15);
    assert.deepEqual(q.map((b) => b.n), [3, 3, 3]);
    assert.equal(q[1]!.time, est[3]!.time);
  });
  it("is DST-safe (EDT: 09:30 ET = 13:30Z)", () => {
    const edt = mk(Date.UTC(2026, 6, 1, 13, 30), 13);
    const h = resample(edt, 60);
    assert.deepEqual(h.map((b) => b.n), [12, 1]);
  });
  it("a new day starts a new bucket", () => {
    const a = mk(Date.UTC(2026, 10, 4, 20, 55), 1); // 15:55 ET
    const b = mk(Date.UTC(2026, 10, 5, 14, 30), 1); // next day 09:30 ET
    assert.equal(resample([...a, ...b], 60).length, 2);
  });
  it("5m resample is the identity on OHLC", () => {
    const r = resample(est.slice(0, 5), 5);
    assert.equal(r.length, 5);
    assert.equal(r[3]!.close, est[3]!.close);
  });
});
