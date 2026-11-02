import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  clusterQuotes,
  decideNeedsReview,
  encodeAgentNote,
  isAgentNote,
  parseAgentNote,
  valuesClose,
  cheapestOf,
} from "./database-agent-resolve.js";

describe("valuesClose", () => {
  it("treats near-equal ratios as close", () => {
    assert.equal(valuesClose(5.396, 5.3534), true);
  });
  it("flags 3x scale gaps", () => {
    assert.equal(valuesClose(5.4, 3.24, 0.15), false);
  });
});

describe("clusterQuotes + cheapestOf", () => {
  it("groups agreeing free sources and prefers yahoo over finnhub", () => {
    const q = [
      { source: "finnhub", value: 5.35 },
      { source: "yahoo", value: 5.4 },
      { source: "alpha_vantage", value: 8.78 },
    ];
    const clusters = clusterQuotes(q);
    assert.equal(clusters[0].length, 2);
    assert.equal(cheapestOf(clusters[0])!.source, "yahoo");
  });
});

describe("decideNeedsReview", () => {
  it("majority_cheap picks yahoo when yahoo≈finnhub and AV outliers", () => {
    const d = decideNeedsReview({
      free: [
        { source: "yahoo", value: 5.4 },
        { source: "finnhub", value: 5.35 },
        { source: "alpha_vantage", value: 8.78 },
      ],
    });
    assert.equal(d.action, "override");
    if (d.action === "override") {
      assert.equal(d.reason, "majority_cheap");
      assert.equal(d.source, "yahoo");
      assert.ok(isAgentNote(encodeAgentNote(d)));
    }
  });

  it("research_confirms_cheap when WRDS agrees with lone yahoo", () => {
    const d = decideNeedsReview({
      free: [
        { source: "yahoo", value: 12.1 },
        { source: "fmp", value: 4.0 },
      ],
      research: [{ source: "wrds", value: 11.8, cached: true }],
    });
    // yahoo alone in its cluster if fmp far — research confirms yahoo
    assert.equal(d.action, "override");
    if (d.action === "override") {
      assert.ok(d.reason === "research_confirms_cheap" || d.reason === "majority_cheap");
      assert.equal(d.source, "yahoo");
    }
  });

  it("factset_nearest_free picks free source near FactSet", () => {
    const d = decideNeedsReview({
      free: [
        { source: "yahoo", value: 0.22 },
        { source: "fmp", value: 0.45 },
      ],
      factset: { source: "factset", value: 0.21 },
    });
    assert.equal(d.action, "override");
    if (d.action === "override") {
      assert.equal(d.source, "yahoo");
      assert.equal(d.reason, "factset_nearest_free");
    }
  });

  it("skips when free sources fight and no FactSet/research", () => {
    const d = decideNeedsReview({
      free: [
        { source: "yahoo", value: 0.1 },
        { source: "fmp", value: 0.5 },
      ],
    });
    assert.equal(d.action, "skip");
    if (d.action === "skip") assert.equal(d.reason, "ambiguous");
  });

  it("primary_vs_edgar drops edgar on grossProfit", () => {
    const d = decideNeedsReview({
      field: "grossProfit",
      free: [
        { source: "yahoo", value: 42e9 },
        { source: "edgar", value: 12e9 },
      ],
    });
    assert.equal(d.action, "override");
    if (d.action === "override") {
      assert.equal(d.source, "yahoo");
      assert.ok(d.reason === "primary_vs_edgar" || d.reason === "scale_outlier_drop");
    }
  });

  it("derived_confirms_cheap writes manual literal near book-derived P/B", () => {
    const d = decideNeedsReview({
      field: "priceToBook",
      free: [
        { source: "yahoo", value: 5.4 },
        { source: "finnhub", value: 3.24 },
        { source: "alpha_vantage", value: 8.78 },
      ],
      derived: { source: "derived", value: 5.35 },
    });
    assert.equal(d.action, "override");
    if (d.action === "override") {
      assert.equal(d.source, "manual");
      assert.equal(d.reason, "derived_confirms_cheap");
      assert.ok(Math.abs(d.value - 5.35) < 1e-9);
    }
  });

  it("scale_outlier_drop keeps yahoo when AV is 3x+", () => {
    const d = decideNeedsReview({
      free: [
        { source: "yahoo", value: 1.0 },
        { source: "finnhub", value: 1.05 },
        { source: "alpha_vantage", value: 4.0 },
      ],
    });
    assert.equal(d.action, "override");
    if (d.action === "override") {
      assert.equal(d.source, "yahoo");
      assert.ok(d.reason === "majority_cheap" || d.reason === "scale_outlier_drop");
    }
  });
});

describe("parseAgentNote", () => {
  it("round-trips chose/val/reason", () => {
    const note = encodeAgentNote({
      action: "override",
      source: "yahoo",
      value: 5.4,
      reason: "majority_cheap",
      cluster: [
        { source: "yahoo", value: 5.4 },
        { source: "finnhub", value: 5.35 },
      ],
      rejected: [{ source: "alpha_vantage", value: 8.78 }],
      research: [{ source: "wrds", value: 5.3 }],
    });
    const p = parseAgentNote(note)!;
    assert.equal(p.chose, "yahoo");
    assert.equal(p.reason, "majority_cheap");
    assert.ok(p.cluster?.includes("yahoo"));
    assert.ok(p.research?.includes("wrds"));
  });
});
