import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeVolatilityImplications } from "./macro-volatility.ts";
import { computeLiquidityImplications } from "./macro-liquidity.ts";
import type { ChartPoint, VixCurvePoint } from "../macro-data.ts";

const one = (value: number): ChartPoint[] => [{ date: "2026-10-01", value }];
const isoDaysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
/** Two points: `past` ~100 days ago (picked up by valueDaysAgo(91)), `latest` today. */
const trend = (past: number, latest: number): ChartPoint[] => [
  { date: isoDaysAgo(100), value: past },
  { date: isoDaysAgo(0), value: latest },
];
const curve = (front: number, back: number): VixCurvePoint[] => [
  { tenor: "30D", days: 30, value: front, weekAgo: null } as VixCurvePoint,
  { tenor: "93D", days: 93, value: back, weekAgo: null } as VixCurvePoint,
];

type VolArg = "vix" | "curve" | "vvix" | "pcr" | "hy" | "move";
function vol(only: Partial<Record<VolArg, ChartPoint[] | VixCurvePoint[]>>) {
  return computeVolatilityImplications(
    (only.vix ?? []) as ChartPoint[],
    (only.curve ?? []) as VixCurvePoint[],
    (only.vvix ?? []) as ChartPoint[],
    (only.pcr ?? []) as ChartPoint[],
    (only.hy ?? []) as ChartPoint[],
    (only.move ?? []) as ChartPoint[],
  );
}
const volLevel = (arg: VolArg, series: ChartPoint[] | VixCurvePoint[]) => {
  const r = vol({ [arg]: series });
  assert.equal(r.signals.length, 1);
  return r.signals[0]!.level;
};

describe("computeVolatilityImplications thresholds", () => {
  it("VIX 15 / 20 / 30", () => {
    assert.equal(volLevel("vix", one(14.99)), "calm");
    assert.equal(volLevel("vix", one(15)), "normal");
    assert.equal(volLevel("vix", one(20)), "normal");
    assert.equal(volLevel("vix", one(20.01)), "elevated");
    assert.equal(volLevel("vix", one(30)), "elevated");
    assert.equal(volLevel("vix", one(30.01)), "stress");
  });

  it("term structure spread (30D − 93D) -1 / 1 / 3", () => {
    assert.equal(volLevel("curve", curve(15, 17)), "calm");
    assert.equal(volLevel("curve", curve(15, 16)), "calm"); // spread -1 is not > -1
    assert.equal(volLevel("curve", curve(15, 15)), "normal");
    assert.equal(volLevel("curve", curve(16, 15)), "normal"); // spread 1 is not > 1
    assert.equal(volLevel("curve", curve(17, 15)), "elevated");
    assert.equal(volLevel("curve", curve(18, 15)), "elevated");
    assert.equal(volLevel("curve", curve(18.5, 15)), "stress");
  });

  it("VVIX 90 / 100 / 120", () => {
    assert.equal(volLevel("vvix", one(89.9)), "calm");
    assert.equal(volLevel("vvix", one(90)), "normal");
    assert.equal(volLevel("vvix", one(100)), "normal");
    assert.equal(volLevel("vvix", one(100.1)), "elevated");
    assert.equal(volLevel("vvix", one(120)), "elevated");
    assert.equal(volLevel("vvix", one(120.1)), "stress");
  });

  it("put/call 0.7 / 1.0 / 1.3", () => {
    assert.equal(volLevel("pcr", one(0.69)), "calm");
    assert.equal(volLevel("pcr", one(0.7)), "normal");
    assert.equal(volLevel("pcr", one(1.0)), "normal");
    assert.equal(volLevel("pcr", one(1.01)), "elevated");
    assert.equal(volLevel("pcr", one(1.3)), "elevated");
    assert.equal(volLevel("pcr", one(1.31)), "stress");
  });

  it("HY OAS (percent series → bps) 350 / 400 / 500", () => {
    assert.equal(volLevel("hy", one(3.49)), "calm");
    assert.equal(volLevel("hy", one(3.5)), "normal");
    assert.equal(volLevel("hy", one(4.0)), "normal");
    assert.equal(volLevel("hy", one(4.01)), "elevated");
    assert.equal(volLevel("hy", one(5.0)), "elevated");
    assert.equal(volLevel("hy", one(5.01)), "stress");
  });

  it("MOVE 90 / 110 / 140", () => {
    assert.equal(volLevel("move", one(89)), "calm");
    assert.equal(volLevel("move", one(90)), "normal");
    assert.equal(volLevel("move", one(110)), "normal");
    assert.equal(volLevel("move", one(111)), "elevated");
    assert.equal(volLevel("move", one(140)), "elevated");
    assert.equal(volLevel("move", one(141)), "stress");
  });

  it("uses the latest point by date, not array order", () => {
    const pts = [{ date: "2026-10-02", value: 35 }, { date: "2026-09-01", value: 12 }];
    assert.equal(volLevel("vix", pts), "stress");
  });

  it("overall averages known signals (compound case)", () => {
    // stress (-2) + stress (-2) + calm (+1) → -1 → elevated
    const r = vol({ vix: one(35), vvix: one(130), move: one(80) });
    assert.equal(r.overall.level, "elevated");
    // all stress → stress; all calm → calm; none → normal
    assert.equal(vol({ vix: one(35), vvix: one(130), pcr: one(1.5) }).overall.level, "stress");
    assert.equal(vol({ vix: one(12), vvix: one(80) }).overall.level, "calm");
    assert.equal(vol({}).overall.level, "normal");
    assert.equal(vol({}).signals.length, 0);
  });
});

type LiqArg = "netLiq" | "rrp" | "nfci" | "hy" | "sofr";
function liq(only: Partial<Record<LiqArg, ChartPoint[]>>) {
  return computeLiquidityImplications(
    only.netLiq ?? [], only.rrp ?? [], only.nfci ?? [], only.hy ?? [], only.sofr ?? [],
  );
}
const liqLevel = (arg: LiqArg, series: ChartPoint[]) => {
  const r = liq({ [arg]: series });
  assert.equal(r.signals.length, 1);
  return r.signals[0]!.level;
};

describe("computeLiquidityImplications thresholds", () => {
  it("net liquidity 3-month change ±2%", () => {
    assert.equal(liqLevel("netLiq", trend(6000, 6121)), "supportive"); // +2.02%
    assert.equal(liqLevel("netLiq", trend(6000, 6120)), "neutral"); // +2.00%
    assert.equal(liqLevel("netLiq", trend(6000, 5880)), "neutral"); // -2.00%
    assert.equal(liqLevel("netLiq", trend(6000, 5879)), "draining");
  });

  it("RRP 75 / 300 (supportive only when also falling)", () => {
    assert.equal(liqLevel("rrp", trend(400, 301)), "supportive");
    assert.equal(liqLevel("rrp", trend(200, 301)), "neutral"); // rising
    assert.equal(liqLevel("rrp", trend(400, 300)), "neutral"); // 300 is not > 300
    assert.equal(liqLevel("rrp", trend(100, 75)), "neutral"); // 75 is not < 75
    assert.equal(liqLevel("rrp", trend(100, 74)), "draining");
  });

  it("SOFR − IORB 0 / 5 / 15 bps", () => {
    assert.equal(liqLevel("sofr", one(-1)), "supportive");
    assert.equal(liqLevel("sofr", one(0)), "supportive");
    assert.equal(liqLevel("sofr", one(0.1)), "neutral");
    assert.equal(liqLevel("sofr", one(5)), "neutral");
    assert.equal(liqLevel("sofr", one(5.1)), "draining");
    assert.equal(liqLevel("sofr", one(15)), "draining");
    assert.equal(liqLevel("sofr", one(15.1)), "stress");
  });

  it("NFCI -0.1 / 0.1 / 0.5", () => {
    assert.equal(liqLevel("nfci", one(-0.11)), "supportive");
    assert.equal(liqLevel("nfci", one(-0.1)), "neutral");
    assert.equal(liqLevel("nfci", one(0.1)), "neutral");
    assert.equal(liqLevel("nfci", one(0.11)), "draining");
    assert.equal(liqLevel("nfci", one(0.5)), "draining");
    assert.equal(liqLevel("nfci", one(0.51)), "stress");
  });

  it("HY OAS 350 / 400 / 500 bps, plus >50 bps 3-month widening = stress", () => {
    assert.equal(liqLevel("hy", trend(3.4, 3.49)), "supportive");
    assert.equal(liqLevel("hy", trend(3.5, 3.5)), "neutral");
    assert.equal(liqLevel("hy", trend(4.0, 4.0)), "neutral");
    assert.equal(liqLevel("hy", trend(4.01, 4.01)), "draining");
    assert.equal(liqLevel("hy", trend(5.0, 5.0)), "draining");
    assert.equal(liqLevel("hy", trend(5.01, 5.01)), "stress");
    assert.equal(liqLevel("hy", trend(2.8, 3.31)), "stress"); // tight level but +51 bps
    assert.equal(liqLevel("hy", trend(2.8, 3.3)), "supportive"); // +50 bps is not > 50
  });

  it("overall averages known signals (compound case)", () => {
    // supportive (+1) + draining (-1) + stress (-2) → -0.67 → draining
    const r = liq({ sofr: one(-1), nfci: one(0.3), hy: trend(5.5, 5.5) });
    assert.equal(r.overall.level, "draining");
    assert.equal(liq({ sofr: one(20), nfci: one(0.8) }).overall.level, "stress");
    assert.equal(liq({ sofr: one(-1), nfci: one(-0.5) }).overall.level, "supportive");
    assert.equal(liq({}).overall.level, "neutral");
  });
});
