import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { crossCheck, earningsExposure, interpretLseg, ownershipSummary, rankPhrase, recLabel, tradeHints, type LsegInput, type LsegSignals } from "./lseg-interpret.ts";

function sig(over: Partial<LsegSignals> = {}): LsegSignals {
  return {
    asOf: "2026-10-04",
    price: 100,
    epsMeanFy1: 5,
    epsDrift30dPct: 0,
    numEst: 20,
    fy1Period: "FY2026",
    recMean: 2.2,
    ptMean: 120,
    ptUpsidePct: 20,
    predSurprisePct: 0.3,
    fq1PeriodEnd: "2026-09-30",
    armRank: 50,
    combinedAlphaRank: 50,
    valmoRank: 50,
    shortPct: 3,
    shortPctFloat: 3,
    issuerRating: null,
    ...over,
  };
}

const input = (s: Partial<LsegSignals>, extra: Partial<LsegInput> = {}): LsegInput => ({
  signals: sig(s),
  nextEarnings: null,
  myPosition: null,
  ...extra,
});

describe("rankPhrase / recLabel", () => {
  it("phrases ranks as top/bottom percent", () => {
    assert.equal(rankPhrase(99), "top 2%");
    assert.equal(rankPhrase(100), "top 1%");
    assert.equal(rankPhrase(7), "bottom 7%");
  });
  it("maps 1–5 rec scale", () => {
    assert.equal(recLabel(1.4), "Strong Buy");
    assert.equal(recLabel(2.3), "Buy");
    assert.equal(recLabel(3.0), "Hold");
  });
});

describe("verdict", () => {
  it("positive when ARM + CAM high and beat predicted", () => {
    const r = interpretLseg(input({ armRank: 99, combinedAlphaRank: 93, predSurprisePct: 2.5 }));
    assert.equal(r.verdict.tone, "good");
    assert.match(r.verdict.text, /StarMine leans beat/);
  });
  it("negative for OPEN-like profile (ARM 7, CAM 2, PS -7.4)", () => {
    const r = interpretLseg(input({ armRank: 7, combinedAlphaRank: 2, predSurprisePct: -7.39, numEst: 7 }));
    assert.equal(r.verdict.tone, "bad");
    assert.match(r.verdict.text, /estimates being cut/);
  });
  it("OPEN with one positive drift still reads negative (net count)", () => {
    const r = interpretLseg(input({ armRank: 7, combinedAlphaRank: 2, predSurprisePct: -7.39, epsDrift30dPct: 2.3 }));
    assert.equal(r.verdict.tone, "bad");
  });
  it("OKLO (CAM 1, PS -16.7, drift +6.9) leans negative", () => {
    const r = interpretLseg(input({ armRank: 43, combinedAlphaRank: 1, predSurprisePct: -16.71, epsDrift30dPct: 6.87 }));
    assert.equal(r.verdict.tone, "bad");
    assert.match(r.verdict.text, /^Leaning negative/);
  });
  it("names the actual holding in the revisions warning", () => {
    const r = interpretLseg(input({ armRank: 7 }, { myPosition: { shares: 3700, options: [] } }));
    assert.ok(r.takeaways.some((t) => /your 3,700 shares/.test(t.detail)));
  });
  it("no coverage for ETFs", () => {
    const r = interpretLseg(input({ numEst: null, armRank: null, combinedAlphaRank: null, predSurprisePct: null }));
    assert.equal(r.coverage, "none");
    assert.match(r.verdict.text, /No analyst coverage/);
  });
  it("flags thin coverage", () => {
    const r = interpretLseg(input({ numEst: 2 }));
    assert.equal(r.coverage, "thin");
    assert.ok(r.takeaways.some((t) => /Only 2 analysts/.test(t.title)));
  });
});

describe("earnings exposure", () => {
  const opts = [
    { type: "put", direction: "short", strike: 7, expiration: "2026-10-17", qty: 8 },
    { type: "put", direction: "short", strike: 6, expiration: "2026-11-21", qty: 2 },
  ];
  it("splits options by expiry vs report date", () => {
    const e = earningsExposure(opts, "2026-11-10");
    assert.equal(e.exposed.length, 1);
    assert.equal(e.clear.length, 1);
  });
  it("short puts open through a predicted miss → bad takeaway first", () => {
    const r = interpretLseg(
      input(
        { predSurprisePct: -16.7 },
        {
          nextEarnings: { date: "2026-11-10", type: "EarningsReleases", title: null, daysUntil: 37 },
          myPosition: { shares: null, options: opts },
        },
      ),
    );
    assert.equal(r.takeaways[0].tone, "bad");
    assert.match(r.takeaways[0].detail, /assignment/);
  });
  it("all options expire before earnings → good", () => {
    const r = interpretLseg(
      input(
        {},
        {
          nextEarnings: { date: "2026-12-01", type: "EarningsReleases", title: null, daysUntil: 58 },
          myPosition: { shares: null, options: [opts[0]] },
        },
      ),
    );
    assert.ok(r.takeaways.some((t) => t.tone === "good" && /after your options expire/.test(t.title)));
  });
});

describe("credit", () => {
  it("distress takeaway mentions your short puts", () => {
    const r = interpretLseg(input({ creditRank: 12 }, { myPosition: { shares: null, options: [{ type: "put", direction: "short", strike: 7, expiration: "2026-10-17", qty: 8 }] } }));
    const t = r.takeaways.find((x) => /distress risk/.test(x.title));
    assert.ok(t && t.tone === "bad");
    assert.match(t!.detail, /your short puts/);
    assert.equal(r.rows.find((x) => x.key === "credit")?.tone, "bad");
  });
});

describe("ownership", () => {
  const h = (rank: number, pct: number, chg: number, type = "Investment Advisor", investor = `Fund ${rank}`) =>
    ({ rank, investor, type, pctOut: pct, changeShares: chg, filingDate: "2026-06-30" });
  it("ONDS-like: 9 of 10 adding + a PE block → good + PE overhang warning", () => {
    const holders = [h(1, 5.8, 1), h(2, 5.6, 1, "Private Equity", "Highlander Partners"), ...[3, 4, 5, 6, 7, 8, 9].map((r) => h(r, 2, 1)), h(10, 1, -1)];
    const r = interpretLseg(input({}, { topHolders: holders }));
    assert.ok(r.takeaways.some((t) => t.tone === "good" && /adding \(9 of top 10\)/.test(t.title)));
    assert.ok(r.takeaways.some((t) => t.tone === "warn" && /Private Equity owns 5\.6%/.test(t.title)));
    assert.equal(ownershipSummary(holders)!.top10Pct.toFixed(1), "26.4");
  });
});

describe("sanity flags", () => {
  it("implausible price target (GOSS 7×) is flagged, not celebrated", () => {
    const r = interpretLseg(input({ ptUpsidePct: 632.8 }));
    assert.ok(r.takeaways.some((t) => /unreliable/.test(t.title)));
    assert.equal(r.rows.find((x) => x.key === "pt")?.tone, "warn");
  });
  it("aggressive (not stale) small-cap target at 2.7×", () => {
    const r = interpretLseg(input({ ptUpsidePct: 168 }));
    assert.ok(r.takeaways.some((t) => /very aggressive/.test(t.title)));
    assert.ok(!r.takeaways.some((t) => /unreliable/.test(t.title)));
  });
  it("heavy short interest (ONDS 44% float)", () => {
    const r = interpretLseg(input({ shortPctFloat: 44 }));
    assert.ok(r.takeaways.some((t) => /Heavily shorted: 44%/.test(t.title)));
  });
});

describe("trade hints + cross-check", () => {
  it("negative street → put caution, covered calls supported", () => {
    const i = input({ armRank: 2, combinedAlphaRank: 1, predSurprisePct: -3 });
    const h = tradeHints(i, interpretLseg(i));
    assert.equal(h.put.tone, "bad");
    assert.equal(h.call.tone, "good");
    assert.match(h.directional, /overbought/);
  });
  it("positive street + beat → call caution", () => {
    const i = input({ armRank: 99, combinedAlphaRank: 93, predSurprisePct: 2.5 });
    const h = tradeHints(i, interpretLseg(i));
    assert.equal(h.put.tone, "good");
    assert.equal(h.call.tone, "warn");
  });
  it("crowded short adds gap-sizing note", () => {
    const i = input({ shortPctFloat: 44 });
    assert.match(tradeHints(i, interpretLseg(i)).put.text, /size for it/);
  });
  it("cross-check agree / disagree / missing", () => {
    assert.equal(crossCheck("good", "supportive")?.tone, "good");
    assert.equal(crossCheck("bad", "supportive")?.tone, "warn");
    assert.equal(crossCheck("warn", "supportive")?.tone, "warn");
    assert.match(crossCheck("warn", "supportive")?.text ?? "", /beat streak|StarMine|forward/i);
    assert.equal(crossCheck("good", null), null);
  });
});
