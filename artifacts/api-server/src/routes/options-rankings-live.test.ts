/**
 * A274 — /api/options/rankings livePrices flag (default off).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rankingsWantLivePrices } from "../lib/rankings-live-prices.js";

describe("rankingsWantLivePrices (A274)", () => {
  it("default / missing / 0 → skip quote helper", () => {
    assert.equal(rankingsWantLivePrices(undefined), false);
    assert.equal(rankingsWantLivePrices(null), false);
    assert.equal(rankingsWantLivePrices(""), false);
    assert.equal(rankingsWantLivePrices("0"), false);
    assert.equal(rankingsWantLivePrices(0), false);
  });

  it("livePrices=1 → call quote helper", () => {
    assert.equal(rankingsWantLivePrices("1"), true);
    assert.equal(rankingsWantLivePrices(1), true);
  });

  it("junk values stay off (no accidental vendor spend)", () => {
    assert.equal(rankingsWantLivePrices("true"), false);
    assert.equal(rankingsWantLivePrices("yes"), false);
    assert.equal(rankingsWantLivePrices("2"), false);
  });
});
