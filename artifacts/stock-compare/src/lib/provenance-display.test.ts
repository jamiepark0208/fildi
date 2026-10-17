import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ESTIMATE_FIELDS,
  freshnessBand,
  formatProvenanceTip,
  scoreKeyFromTopMetricLabel,
  SCORE_KEY_TO_PROV,
  type ProvTipField,
} from "./provenance-display.ts";

function fp(partial: Partial<ProvTipField> & Pick<ProvTipField, "field">): ProvTipField {
  return {
    winningSource: null,
    isOverride: false,
    divergent: false,
    fetchedAt: null,
    override: null,
    ...partial,
  };
}

describe("provenance-display", () => {
  it("maps score keys to provenance fields", () => {
    assert.equal(SCORE_KEY_TO_PROV.roe, "returnOnEquity");
    assert.equal(SCORE_KEY_TO_PROV.revGrowth, "revenueGrowthYoY");
  });

  it("strips percentile suffix from top-metric labels", () => {
    assert.equal(scoreKeyFromTopMetricLabel("roe p72"), "roe");
  });

  it("marks forward/analyst fields as estimates", () => {
    assert.equal(ESTIMATE_FIELDS.has("forwardPe"), true);
    assert.equal(ESTIMATE_FIELDS.has("peRatio"), false);
  });

  it("freshness bands by age", () => {
    assert.equal(freshnessBand(null), "unknown");
    assert.equal(freshnessBand(new Date().toISOString()), "fresh");
    const d15 = new Date(Date.now() - 15 * 86_400_000).toISOString();
    assert.equal(freshnessBand(d15), "ok");
    const d60 = new Date(Date.now() - 60 * 86_400_000).toISOString();
    assert.equal(freshnessBand(d60), "stale");
  });

  it("formats tip with source + as-of", () => {
    const tip = formatProvenanceTip(fp({
      field: "peRatio",
      winningSource: "yahoo",
      fetchedAt: new Date().toISOString(),
      divergent: true,
    }));
    assert.ok(tip?.includes("yahoo"));
    assert.ok(tip?.includes("as of"));
    assert.ok(tip?.includes("sources disagree"));
  });
});
