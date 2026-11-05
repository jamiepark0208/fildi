import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ResampledBar } from "@workspace/indicators";
import { barCtx, bestStructure, buildScorecard, confidence, exitFor, gradeAt, pairStat, randomIndex, roundTrip, statsFor, verdictFor, type ScoreInput } from "./indicator-grading.js";

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

describe("round trip", () => {
  // two sessions: Nov 2 (k 0..5) and Nov 3 (k 288..293 = +1 day)
  const day2 = (k: number, c: number) => mk(288 + k, c, c, c, c);
  const bars = [100, 101, 102, 101, 103, 104].map((c, k) => mk(k, c, c, c, c)).concat([50, 50, 50, 50, 50, 50].map((c, k) => day2(k, c)));
  const ctx = barCtx(bars);
  const rix = randomIndex(bars, ctx);
  const atrS = bars.map(() => 1);
  it("exits at the next opposite signal in the session, else the session close", () => {
    const sig = [{ i: 0, side: "buy" as const }, { i: 1, side: "buy" as const }, { i: 3, side: "sell" as const }, { i: 7, side: "sell" as const }];
    assert.deepEqual(exitFor(0, "buy", sig, ctx), { j: 3, exit: "flip" });
    assert.deepEqual(exitFor(3, "sell", sig, ctx), { j: 5, exit: "close" }); // next buy is tomorrow -> flat at close
    const rt = roundTrip(bars, 0, "buy", exitFor(0, "buy", sig, ctx), rix, "k", atrS)!;
    assert.ok(Math.abs(rt.rtPct - 1) < 1e-9 && rt.rtBars === 3);
    const s = roundTrip(bars, 3, "sell", exitFor(3, "sell", sig, ctx), rix, "k", atrS)!;
    assert.ok(Math.abs(s.rtPct - (-(104 / 101 - 1) * 100)) < 1e-9);
  });
  it("random comparator = same side + hold length, never crossing a session, seeded", () => {
    const a = roundTrip(bars, 0, "buy", { j: 5, exit: "close" }, rix, "k", atrS)!; // L = 5: only bar 0 of each session qualifies
    // starts: day1 k0 (+4 %) or day2 k0 (0 %); mean must lie between and repeat exactly for the same seed
    assert.ok(a.rtRandomPct! >= 0 && a.rtRandomPct! <= 4 + 1e-9);
    assert.equal(roundTrip(bars, 0, "buy", { j: 5, exit: "close" }, rix, "k", atrS)!.rtRandomPct, a.rtRandomPct);
  });
  it("structure facts: |move|, no 1 ATR breach, +1 ATR target", () => {
    const b = roundTrip(bars, 0, "buy", { j: 5, exit: "close" }, rix, "k", atrS)!; // 100 -> 104, low never < 100
    assert.ok(Math.abs(b.absPct - 4) < 1e-9 && b.noBreach === true && b.target === true);
    assert.equal(b.bracket, true);
    const s = roundTrip(bars, 0, "sell", { j: 5, exit: "close" }, rix, "k", atrS)!; // short: high 104 = 4 ATR against
    assert.ok(s.noBreach === false && s.target === false && Math.abs(s.absPct - 4) < 1e-9);
    assert.equal(s.bracket, false);
  });
  it("structure facts use the fixed horizon, not the signal's own exit (no stopping-time look-ahead)", () => {
    const early = roundTrip(bars, 0, "buy", { j: 1, exit: "flip" }, rix, "k", atrS)!; // exits after 1 bar
    assert.ok(Math.abs(early.rtPct - 1) < 1e-9 && Math.abs(early.absPct - 4) < 1e-9); // trip = 1 bar, structures = to close
  });
});

let seed = 12345;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
// per-trade round trip ~ N(edge, 0.5 %) vs random ~ N(0, 0.5 %)
const g = () => Math.sqrt(-2 * Math.log(rnd() || 1e-12)) * Math.cos(2 * Math.PI * rnd());
const rows = (n: number, edgePct: number, days: number): ScoreInput[] =>
  Array.from({ length: n }, (_, k) => ({ indicatorId: "x", version: 1, kind: "Buy", tf: "5m", day: `d${Math.floor((k * days) / n)}`, time: k,
    rtPct: edgePct + 0.5 * g(), rtRandomPct: 0.5 * g() / 7, rtRandomWin: 0.5, hit: null, placeboHit: null }));

describe("verdict rule (fixed, round-trip lift in % per trade)", () => {
  it("thresholds", () => {
    assert.equal(verdictFor(0.1, 2, true, 0.2), "likely useful");
    assert.equal(verdictFor(0.1, 2, false, 0.2), "too early");
    assert.equal(verdictFor(0.09, 5, true, 0.2), "too early");
    assert.equal(verdictFor(-0.1, -2, true, 0.2), "likely worse than random");
    assert.equal(verdictFor(-0.1, -2, false, 0.2), "too early");
    assert.equal(verdictFor(0.04, 0.5, true, 0.1), "likely noise");
    assert.equal(verdictFor(0.04, 0.5, true, 0.11), "too early");
  });
  it("edge over many days is useful, negative edge is worse than random, none is noise, few is too early", () => {
    assert.equal(statsFor(rows(4000, 0.2, 40))!.verdict, "likely useful");
    assert.equal(statsFor(rows(4000, -0.2, 40))!.verdict, "likely worse than random");
    assert.equal(statsFor(rows(40000, 0, 60))!.verdict, "likely noise");
    const few = statsFor(rows(8, 1, 4))!;
    assert.equal(few.verdict, "too early");
    assert.ok(few.needMore! > 0);
  });
  it("structures: vol edge with no direction edge picks a straddle; confidence shrinks small cells to random", () => {
    const r = Array.from({ length: 3000 }, (_, k) => ({ day: `d${k % 40}`, time: k }));
    const vol = pairStat(r, r.map(() => 0.6 + 0.3 * g()), r.map(() => 0.4 + 0.3 * g()), { useful: 0.1, noise: 0.05 })!;
    const dir = pairStat(r, r.map(() => 0.4 * g()), r.map(() => 0.4 * g()), { useful: 0.1, noise: 0.05 })!;
    assert.equal(vol.verdict, "likely useful");
    assert.match(bestStructure({ direction: dir, vol })!, /straddle/);
    assert.equal(bestStructure({ direction: dir }), null);
    const c = confidence(9, 10, 0.5); // 90 % on 10 trips reads ~60 %, not 90
    assert.ok(c.p > 0.55 && c.p < 0.65 && c.lo < 0.5);
  });
  it("buildScorecard pools kind x tf with ALL rows", () => {
    const sc = buildScorecard([...rows(20, 0, 5), ...rows(20, 0, 5).map((r) => ({ ...r, kind: "Sell", tf: "15m" }))]);
    const keys = sc.map((r) => `${r.kind}/${r.tf}`).sort();
    assert.deepEqual(keys, ["ALL/15m", "ALL/5m", "ALL/ALL", "Buy/5m", "Buy/ALL", "Sell/15m", "Sell/ALL"]);
    assert.equal(sc.find((r) => r.kind === "ALL" && r.tf === "ALL")!.n, 40);
  });
});
