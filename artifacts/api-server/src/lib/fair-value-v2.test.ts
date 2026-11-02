import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFairValueV2 } from "./fair-value-v2.js";

const street = (median: number) => ({ median, low: null, high: null, analysts: 30, source: "LSEG I/B/E/S", asOf: "2026-11-02" });
const pt = (source: string, value: number) => ({ source, label: source, value, asOf: "2026-11-02" });
const lab = (p50: number, pricePct: number) => ({ valued: true, p10: p50 / 2, p50, p90: p50 * 2, pricePct, reason: null, asOf: "2026-11-02" });

describe("fair value v2 chips", () => {
  it("no headline when street and cash-flow are > 2× apart (PLTR-like)", () => {
    const v = buildFairValueV2({ price: 184, street: street(210), points: [pt("starmine", 38), pt("fmp_dcf", 9.5)], lab: lab(33, 1) });
    assert.equal(v.headline, null);
    assert.equal(v.cashFlow!.low, 9.5);
    assert.equal(v.cashFlow!.high, 38);
    assert.equal(v.cashFlow!.mid, 33);
    assert.equal(v.reverse!.text, "Price is above our P99 cash-flow outcome");
    assert.match(v.headlineWhy, /street \$210 vs cash-flow \$33/);
  });

  it("midpoint headline when families agree within 2× (MSFT-like)", () => {
    const v = buildFairValueV2({ price: 531, street: street(615), points: [pt("starmine", 377), pt("fmp_dcf", 281)], lab: lab(339, 0.85) });
    assert.equal(v.cashFlow!.mid, 339);
    assert.equal(v.headline, (615 + 339) / 2);
    assert.equal(v.reverse!.text, "Price needs our P85 cash-flow outcome");
  });

  it("one family only → no headline; unvalued lab gives its reason", () => {
    const v = buildFairValueV2({ price: 4.2, street: street(9), points: [], lab: { valued: false, p10: null, p50: null, p90: null, pricePct: null, reason: "pre-revenue", asOf: "2026-11-02" } });
    assert.equal(v.headline, null);
    assert.equal(v.cashFlow, null);
    assert.equal(v.headlineWhy, "Only the street family has a value");
    assert.equal(v.reverse!.text, "Not valued by our DCF: pre-revenue");
  });

  it("sets aside unit-mismatch points (SKHY-like)", () => {
    const v = buildFairValueV2({ price: 136, street: street(250), points: [pt("starmine", 691), pt("fildi_rim", 120)], lab: null });
    assert.deepEqual(v.cashFlow!.points.map((p) => p.source), ["fildi_rim"]);
    assert.deepEqual(v.cashFlow!.unitsCheck.map((p) => p.source), ["starmine"]);
  });
});
