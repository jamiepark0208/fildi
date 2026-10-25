import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { scoreIvAbsolute } from "./option-scorer.ts";
import {
  collectSideIVsFromChains,
  isRelaxedComponentScores,
  RELAXED_COMPONENT,
} from "./side-ivs.ts";

describe("side IVs (A256)", () => {
  it("collects put vs call IVs separately", () => {
    const chains = [{
      puts: [{ iv: 0.2 }, { iv: 0.3 }, { iv: 0 }],
      calls: [{ iv: 0.5 }, { iv: 0.6 }],
    }];
    assert.deepEqual(collectSideIVsFromChains(chains, false).sort(), [0.2, 0.3]);
    assert.deepEqual(collectSideIVsFromChains(chains, true).sort(), [0.5, 0.6]);
  });

  it("call IV at call median scores near middle; same IV vs puts can look extreme", () => {
    const putIVs = [0.10, 0.12, 0.14, 0.16, 0.18];
    const callIVs = [0.40, 0.45, 0.50, 0.55, 0.60];
    const midCall = 0.50;
    const vsCalls = scoreIvAbsolute(midCall, callIVs)!;
    const vsPuts = scoreIvAbsolute(midCall, putIVs)!;
    assert.ok(vsCalls > 0.4 && vsCalls < 0.7, `call-vs-call median → mid, got ${vsCalls}`);
    // Cap (IV_ABSOLUTE_CAP) may clip the top; still clearly above the call-median score.
    assert.ok(vsPuts > vsCalls + 0.2, `same IV vs puts ranks much higher (${vsPuts} vs ${vsCalls})`);
  });

  it("isRelaxedComponentScores reads marker", () => {
    assert.equal(isRelaxedComponentScores({ relaxed: RELAXED_COMPONENT }), true);
    assert.equal(isRelaxedComponentScores({ income: { score: 0.5, weight: 0.3 } }), false);
  });
});
