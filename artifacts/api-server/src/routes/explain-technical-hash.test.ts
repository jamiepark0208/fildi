import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

type HashFn = typeof import("./explain.ts").technicalHash;
let technicalHash: HashFn;

before(async () => {
  process.env.DATABASE_URL ??= "postgres://ci:ci@127.0.0.1:5432/ci";
  ({ technicalHash } = await import("./explain.ts"));
});

function tech(turningPointLine: string | null) {
  return {
    side: "put" as const,
    totalScore: 72.4,
    rank: 3,
    signal: "oversold",
    regime: "neutral",
    componentScores: {
      oversoldDepth: 0.4,
      reversalSignal: 0.2,
      volatilityState: 0.5,
      trendContext: 0.3,
      optionsFlow: 0.1,
      volumeConfirm: 0.2,
    },
    rsi14: 28,
    rsi14Pct: 12,
    ivRank: 60,
    ivVsRealizedVol: 1.2,
    macdDirection: "down",
    fallingKnife: false,
    earningsDaysOut: null,
    reason: "test",
    turningPointLine,
  };
}

describe("technicalHash", () => {
  it("differs when same-length turning-point lines carry different numbers", () => {
    const a = "TP prob 12.4% vs base 8.0% (decile 9)";
    const b = "TP prob 13.4% vs base 8.0% (decile 9)";
    assert.equal(a.length, b.length);
    const emptyCtx = { ticker: "T", stockEvent: null, marketEvent: null, sourceFacts: [] as string[] };
    const ha = technicalHash(emptyCtx, tech(a));
    const hb = technicalHash(emptyCtx, tech(b));
    assert.notEqual(ha, hb);
    assert.match(ha, /_tp[0-9a-f]{12}$/);
    assert.match(hb, /_tp[0-9a-f]{12}$/);
  });

  it("matches for identical payloads and omits _tp when the line is absent", () => {
    const line = "TP prob 12.4% vs base 8.0% (decile 9)";
    const emptyCtx = { ticker: "T", stockEvent: null, marketEvent: null, sourceFacts: [] as string[] };
    assert.equal(technicalHash(emptyCtx, tech(line)), technicalHash(emptyCtx, tech(line)));
    const absent = technicalHash(emptyCtx, tech(null));
    assert.equal(absent, technicalHash(emptyCtx, { ...tech(null), turningPointLine: undefined }));
    assert.equal(absent.includes("_tp"), false);
    assert.notEqual(absent, technicalHash(emptyCtx, tech(line)));
  });
});
