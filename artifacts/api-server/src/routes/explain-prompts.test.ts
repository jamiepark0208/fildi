import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import type { ContextBundle } from "../lib/explain-context.js";

type Surfaces = typeof import("./explain.js").explainSurfacesForTest;
let surfaces: Surfaces;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://ci:ci@127.0.0.1:5432/ci";
  ({ explainSurfacesForTest: surfaces } = await import("./explain.js"));
});

function fixtureBundle(): ContextBundle {
  return {
    ticker: "AAPL",
    stockEvent: { priceZScore: 0.2, recentNews: [] },
    marketEvent: {
      volRegime: "BASELINE",
      sector: { label: "Tech", quadrant: "leading", rs1m: 1.2, rs1w: 0.5 },
    },
    notes: ["2026-10-01 character: held support at 220"],
    sourceFacts: [
      "Street 11-05: supportive — Yahoo 72% bullish; context, not a signal",
      "StockTwits 11-05: p12 (0.30) — cautious vs peers, n 19; context, not a signal",
    ],
  };
}

describe("explain prompts include notes + sourceFacts", () => {
  it("fundamental surface", () => {
    const p = surfaces.fundamental.buildPrompt(fixtureBundle(), {
      totalScore: 80,
      rank: 5,
      familyScores: { value: 70, growth: 60, quality: 80, safety: 75 },
      topMetrics: ["FCF"],
      weakMetrics: [],
      reason: "",
    });
    assert.match(p, /Desk data sources/);
    assert.match(p, /Desk notes on this ticker/);
    assert.match(p, /StockTwits 11-05/);
  });

  it("technical surface", () => {
    const p = surfaces.technicalPut.buildPrompt(fixtureBundle(), {
      totalScore: 70,
      rank: 10,
      signal: "GO",
      regime: "neutral",
      componentScores: {
        oversoldDepth: 0.5,
        reversalSignal: 0.4,
        volatilityState: 0.5,
        trendContext: 0.4,
        optionsFlow: 0.3,
        volumeConfirm: 0.3,
      },
      rsi14: 30,
      rsi14Pct: 15,
      ivRank: 55,
      ivVsRealizedVol: 1.1,
      macdDirection: "flat",
      fallingKnife: false,
      earningsDaysOut: 12,
      reason: "",
    });
    assert.match(p, /Desk data sources/);
    assert.match(p, /Desk notes/);
  });

  it("options surface", () => {
    const b = fixtureBundle();
    const p = surfaces.options.buildPrompt(b, {
      rsi: 28,
      mfi: 40,
      signal: "GO",
      tier: 1,
      ivCurrent: 35,
      vsSpy20d: 2,
    });
    assert.match(p, /Desk data sources/);
    assert.match(p, /Desk notes on this ticker/);
  });

  it("model-pick surface", () => {
    const p = surfaces.modelPick.buildPrompt(fixtureBundle(), {
      runId: 1,
      folderName: "Core",
      item: {
        ticker: "AAPL",
        status: "active",
        verdict: "go",
        folder_key: "core",
        pillars: { own: 70, street: 60, premium: 55 },
        contract: { type: "put", strike: 200, expiry: "2026-12-19", account: "IRA" },
      },
    });
    assert.match(p, /Desk data sources/);
    assert.match(p, /Desk note \(dated history/);
  });
});
