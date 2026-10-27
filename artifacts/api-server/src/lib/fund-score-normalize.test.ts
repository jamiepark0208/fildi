import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeCohort } from "./fund-score-normalize.js";

describe("normalizeCohort reference members (10-27 universe add)", () => {
  const peers = [10, 12, 14, 16, 18, 20, 22, 24, 26];

  it("no reference = unchanged behaviour", () => {
    assert.deepEqual(normalizeCohort(peers, true, peers.map(() => true)), normalizeCohort(peers, true));
  });

  it("an unreviewed outlier does not move reviewed members' scores", () => {
    const before = normalizeCohort(peers, true);
    const withNew = normalizeCohort([...peers, 500], true, [...peers.map(() => true), false]);
    assert.deepEqual(withNew.slice(0, peers.length), before);
    assert.equal(withNew[peers.length], 1);   // scored against the reviewed peers: z capped at +3
  });

  it("missing-value unreviewed members are left null", () => {
    const out = normalizeCohort([...peers, null], true, [...peers.map(() => true), false]);
    assert.equal(out[peers.length], null);
  });

  it("small cohorts rank the unreviewed name against reviewed values", () => {
    const out = normalizeCohort([1, 2, 3, 2.5], true, [true, true, true, false]);
    assert.deepEqual(out.slice(0, 3), normalizeCohort([1, 2, 3], true));
    assert.equal(out[3], 1);   // beats 2 of 3 → 2 / (3 − 1)
  });

  it("fewer than 3 reviewed values falls back to the whole cohort", () => {
    const vals = [1, 2, 3, 4];
    assert.deepEqual(normalizeCohort(vals, true, [true, true, false, false]), normalizeCohort(vals, true));
  });
});
