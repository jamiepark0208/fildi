import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { positionRisks, rankOpportunities, scoreOpportunity, type RadarRow } from "./lseg-radar.ts";
import type { LsegSignals } from "./lseg-interpret.ts";

function sig(over: Partial<LsegSignals> = {}): LsegSignals {
  return {
    asOf: "2026-10-04", price: 20, epsMeanFy1: 1, epsDrift30dPct: 0, numEst: 12, fy1Period: "FY2026",
    recMean: 2, ptMean: 25, ptUpsidePct: 25, predSurprisePct: 0, fq1PeriodEnd: "2026-09-30",
    armRank: 50, combinedAlphaRank: 50, valmoRank: 50, shortPct: 5, shortPctFloat: 5, issuerRating: null,
    ...over,
  };
}

function row(over: Partial<RadarRow> = {}, s: Partial<LsegSignals> = {}): RadarRow {
  return {
    ticker: "XYZ", tier: 4, label: "lookalike", reason: "like POET",
    signals: sig(s),
    tech: { iv: 60, ivVsRealized: 1.0, impliedMoveWeekly: 0.06, rsi: 50, z: 0, regime: "NEUTRAL", fallingKnife: false },
    nextEarnings: null,
    myPosition: { shares: null, options: [] },
    ...over,
  };
}

describe("scoreOpportunity", () => {
  it("strong street + rich premium + oversold scores high with plain bullets", () => {
    const o = scoreOpportunity(
      row({ tech: { iv: 70, ivVsRealized: 1.3, impliedMoveWeekly: 0.07, rsi: 32, z: -1.6, regime: "NEUTRAL", fallingKnife: false } }, { armRank: 90, combinedAlphaRank: 85 }),
    );
    assert.ok(o.score >= 75, `score ${o.score}`);
    assert.ok(o.bullets.some((b) => /Premium is rich/.test(b.text)));
    assert.ok(o.bullets.some((b) => /Oversold/.test(b.text)));
  });
  it("predicted miss before typical expiry is penalised and explained", () => {
    const base = row({ nextEarnings: { date: "2026-10-20", type: "EarningsReleases", title: null, daysUntil: 16 } });
    const ok = scoreOpportunity(base);
    const miss = scoreOpportunity({ ...base, signals: sig({ predSurprisePct: -6 }) });
    assert.ok(miss.score < ok.score);
    assert.equal(miss.bullets[0].tone, "bad");
    assert.match(miss.bullets[0].text, /leans MISS/);
  });
  it("extreme IV (CABA 184%) is not ranked as free premium", () => {
    const tech = { iv: 184, ivVsRealized: 2.46, impliedMoveWeekly: 0.2, rsi: 26, z: -2, regime: "NEUTRAL", fallingKnife: false };
    const o = scoreOpportunity(row({ tech }, { armRank: 40, combinedAlphaRank: 38 }));
    assert.ok(o.bullets.some((b) => /binary event/.test(b.text)));
    assert.ok(!o.bullets.some((b) => /Premium is rich/.test(b.text)));
    assert.ok(o.score < 60, `score ${o.score}`);
  });
  it("weak street can't be carried by premium + timing (TTD-like)", () => {
    const tech = { iv: 60, ivVsRealized: 1.3, impliedMoveWeekly: 0.06, rsi: 30, z: -1, regime: "NEUTRAL", fallingKnife: false };
    const weak = scoreOpportunity(row({ tech }, { armRank: 1, combinedAlphaRank: 51 }));
    const strong = scoreOpportunity(row({ tech }, { armRank: 90, combinedAlphaRank: 85 }));
    assert.ok(strong.score - weak.score >= 20, `${strong.score} vs ${weak.score}`);
  });
  it("fragile credit (OPEN-like credit 1/100) is penalised and explained", () => {
    const ok = scoreOpportunity(row({}, { creditRank: 60 }));
    const weak = scoreOpportunity(row({}, { creditRank: 1 }));
    assert.ok(ok.score - weak.score >= 20, `${ok.score} vs ${weak.score}`);
    assert.match(weak.bullets[0].text, /Fragile balance sheet/);
  });
  it("falling knife penalised", () => {
    const k = scoreOpportunity(row({ tech: { iv: 60, ivVsRealized: 1, impliedMoveWeekly: 0.06, rsi: 25, z: -2.5, regime: "BEARISH", fallingKnife: true } }));
    assert.ok(k.bullets.some((b) => /Falling-knife/.test(b.text)));
  });
});

describe("ranking + positions", () => {
  const rows = [
    row({ ticker: "HELD", tier: 1, label: "held", myPosition: { shares: 100, options: [] } }, { armRank: 5, combinedAlphaRank: 3, predSurprisePct: -8 }),
    row({ ticker: "GOOD" }, { armRank: 95, combinedAlphaRank: 90 }),
    row({ ticker: "MEH" }, { armRank: 40, combinedAlphaRank: 40 }),
    row({ ticker: "NOIV", tech: { iv: null, ivVsRealized: null, impliedMoveWeekly: null, rsi: null, z: null, regime: null, fallingKnife: false } }),
  ];
  it("opportunities exclude held + names without IV, sorted by score", () => {
    const o = rankOpportunities(rows);
    assert.deepEqual(o.map((x) => x.ticker), ["GOOD", "MEH"]);
  });
  it("position risks only for held, worst first", () => {
    const p = positionRisks(rows);
    assert.deepEqual(p.map((x) => x.ticker), ["HELD"]);
    assert.equal(p[0].tone, "bad");
  });
});
