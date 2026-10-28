import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachPeerReviewed, peerReviewedKey } from "./fund-score-peer-reviewed.js";
import type { FundRowInput } from "./fund-score-types.js";

const base = (ticker: string): FundRowInput =>
  ({ ticker, peerGroupId: "g1" }) as FundRowInput;

describe("attachPeerReviewed (A285)", () => {
  it("peer-reference off leaves flag unset", () => {
    const reviewed = new Set([peerReviewedKey("AAPL", "g1")]);
    const out = attachPeerReviewed(base("AAPL"), false, reviewed, "AAPL", "g1");
    assert.equal(out.peerReviewed, undefined);
  });

  it("taxonomy/manual/verified/override key → true", () => {
    const reviewed = new Set([
      peerReviewedKey("AAPL", "g1"), // taxonomy/manual/verified
      peerReviewedKey("ZTO", "g2"), // override merge
    ]);
    assert.equal(attachPeerReviewed(base("AAPL"), true, reviewed, "AAPL", "g1").peerReviewed, true);
    assert.equal(attachPeerReviewed(base("ZTO"), true, reviewed, "ZTO", "g2").peerReviewed, true);
  });

  it("auto-classified (not in set) → false", () => {
    const reviewed = new Set([peerReviewedKey("AAPL", "g1")]);
    assert.equal(attachPeerReviewed(base("NEW"), true, reviewed, "NEW", "g1").peerReviewed, false);
  });

  it("wrong group key → false", () => {
    const reviewed = new Set([peerReviewedKey("AAPL", "g1")]);
    assert.equal(attachPeerReviewed(base("AAPL"), true, reviewed, "AAPL", "g9").peerReviewed, false);
  });
});
