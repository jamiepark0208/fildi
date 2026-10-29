import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decidePriceReplace, priceSourceRank } from "./price-source-rank.js";

describe("priceSourceRank", () => {
  it("Schwab beats Yahoo", () => {
    assert.ok(priceSourceRank("schwab") > priceSourceRank("yahoo"));
  });
  it("Yahoo last among known live sources", () => {
    assert.ok(priceSourceRank("yahoo") < priceSourceRank("lseg"));
    assert.ok(priceSourceRank("yahoo") < priceSourceRank("fmp"));
  });
});

describe("decidePriceReplace", () => {
  it("inserts when nothing stored", () => {
    assert.deepEqual(
      decidePriceReplace({ existingClose: null, existingSource: null, incomingClose: 10, incomingSource: "schwab" }),
      { action: "insert" },
    );
  });
  it("Schwab replaces Yahoo when close within 2%", () => {
    assert.deepEqual(
      decidePriceReplace({ existingClose: 100, existingSource: "yahoo", incomingClose: 100.5, incomingSource: "schwab" }),
      { action: "replace" },
    );
  });
  it("keeps Yahoo when Schwab jump ≥ 2%", () => {
    assert.deepEqual(
      decidePriceReplace({ existingClose: 100, existingSource: "yahoo", incomingClose: 105, incomingSource: "schwab" }),
      { action: "keep", reason: "jump" },
    );
  });
  it("Yahoo never overwrites Schwab", () => {
    assert.deepEqual(
      decidePriceReplace({ existingClose: 100, existingSource: "schwab", incomingClose: 100.1, incomingSource: "yahoo" }),
      { action: "keep", reason: "rank" },
    );
  });

  it("same vendor refreshes a recent (possibly mid-session) bar, even past the jump guard", () => {
    assert.deepEqual(
      decidePriceReplace({ existingClose: 768.49, existingSource: "schwab", incomingClose: 773.09, incomingSource: "schwab", recent: true }),
      { action: "replace" },
    );
    assert.deepEqual(
      decidePriceReplace({ existingClose: 100, existingSource: "schwab", incomingClose: 103, incomingSource: "schwab", recent: true }),
      { action: "replace" },
    );
  });

  it("same vendor keeps old bars and identical closes", () => {
    assert.deepEqual(
      decidePriceReplace({ existingClose: 100, existingSource: "schwab", incomingClose: 101, incomingSource: "schwab" }),
      { action: "keep", reason: "same" },
    );
    assert.deepEqual(
      decidePriceReplace({ existingClose: 100, existingSource: "schwab", incomingClose: 100, incomingSource: "schwab", recent: true }),
      { action: "keep", reason: "same" },
    );
  });
});
