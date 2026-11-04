import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResampledBar } from "@workspace/indicators";
import { buildScorecard, gradeAt, statsFor, verdictFor, type ScoreInput } from "./indicator-grading.js";

// 2026-11-02 (Mon, EST) 09:30 ET = 14:30 UTC
const T0 = Date.UTC(2026, 10, 2, 14, 30) / 1000;
const mk = (k: number, o: number, h: number, l: number, c: number): ResampledBar => ({ time: T0 + k * 300, lastTime: T0 + k * 300, end: T0 + (k + 1) * 300, open: o, high: h, low: l, close: c, volume: 1, n: 1 });

describe("gradeAt", () => {
  it("buy hits +0.5 ATR first", () => {
    const bars = [mk(0, 100, 100, 100, 100), mk(1, 100, 100.6, 99.9, 100.4), mk(2, 100.4, 100.5, 99, 99.2)];
    const g = gradeAt(bars, 0, "buy", 1);
    assert.equal(g.hit, true);
    assert.ok(Math.abs(g.mfeAtr! - 0.6) < 1e-9);
  });
  it("buy misses when -0.5 ATR comes first; same bar both = miss", () => {
    assert.equal(gradeAt([mk(0, 100, 100, 100, 100), mk(1, 100, 100.2, 99.4, 99.5), mk(2, 99.5, 101, 99.5, 101)], 0, "buy", 1).hit, false);
    assert.equal(gradeAt([mk(0, 100, 100, 100, 100), mk(1, 100, 100.6, 99.4, 100)], 0, "buy", 1).hit, false);
  });
  it("sell mirrors, neither threshold = miss, last bar of session = ungraded", () => {
    assert.equal(gradeAt([mk(0, 100, 100, 100, 100), mk(1, 100, 100.1, 99.4, 99.5)], 0, "sell", 1).hit, true);
    assert.equal(gradeAt([mk(0, 100, 100, 100, 100), mk(1, 100, 100.2, 99.8, 100)], 0, "buy", 1).hit, false);
    assert.equal(gradeAt([mk(0, 100, 100, 100, 100)], 0, "buy", 1).hit, null);
  });
  it("forward returns use exact bar ends and the signal's direction", () => {
    const bars = Array.from({ length: 14 }, (_, k) => mk(k, 100, 100.1, 99.9, 100 + k * 0.1));
    const b = gradeAt(bars, 0, "buy", 1), s = gradeAt(bars, 0, "sell", 1);
    assert.ok(Math.abs(b.fwd30mPct! - 0.6) < 1e-9 && Math.abs(b.fwd60mPct! - 1.2) < 1e-9);
    assert.ok(Math.abs(s.fwd30mPct! + 0.6) < 1e-9);
    assert.ok(Math.abs(b.fwdClosePct! - 1.3) < 1e-9);
  });
});

let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const rows = (n: number, hitRate: number, placeboRate: number, days: number): ScoreInput[] =>
  Array.from({ length: n }, (_, k) => ({ indicatorId: "x", version: 1, kind: "Buy", tf: "5m", day: `d${Math.floor((k * days) / n)}`, time: k, hit: rnd() < hitRate, placeboHit: rnd() < placeboRate }));

describe("verdict rule (fixed)", () => {
  it("thresholds", () => {
    assert.equal(verdictFor(3, 2, true, 5), "likely useful");
    assert.equal(verdictFor(3, 2, false, 5), "too early");
    assert.equal(verdictFor(2.9, 5, true, 5), "too early");
    assert.equal(verdictFor(1.4, 0.5, true, 3), "likely noise");
    assert.equal(verdictFor(1.4, 0.5, true, 3.1), "too early");
    assert.equal(verdictFor(-8, -4, true, 2), "too early");
  });
  it("strong lift over many days is useful; no lift over many days is noise; few signals is too early with a need-more count", () => {
    const strong = statsFor(rows(4000, 0.6, 0.4, 40))!;
    assert.equal(strong.verdict, "likely useful");
    const flat = statsFor(rows(40000, 0.5, 0.5, 60))!;
    assert.equal(flat.verdict, "likely noise");
    const few = statsFor(rows(8, 0.9, 0.3, 4))!;
    assert.equal(few.verdict, "too early");
    assert.ok(few.needMore! > 0);
  });
  it("buildScorecard pools kind x tf with ALL rows", () => {
    const sc = buildScorecard([...rows(20, 0.5, 0.5, 5), ...rows(20, 0.5, 0.5, 5).map((r) => ({ ...r, kind: "Sell", tf: "15m" }))]);
    const keys = sc.map((r) => `${r.kind}/${r.tf}`).sort();
    assert.deepEqual(keys, ["ALL/15m", "ALL/5m", "ALL/ALL", "Buy/5m", "Buy/ALL", "Sell/15m", "Sell/ALL"]);
    assert.equal(sc.find((r) => r.kind === "ALL" && r.tf === "ALL")!.n, 40);
  });
});
