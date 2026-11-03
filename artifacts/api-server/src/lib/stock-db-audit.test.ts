import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  shouldFlagPickerDrift,
  shouldFlagVendorGap,
  missingL0Inputs,
  nonUsdSkipReason,
} from "./stock-db-audit-guards.js";
import {
  auditL0,
  auditL1,
  l0Expected,
  wilsonCi,
  type AuditInput,
} from "./stock-db-audit.js";

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "stock-db-audit.fixture.json"), "utf8"),
) as {
  peIdentity: AuditInput;
  unitScale: AuditInput;
  vendorDisagree: AuditInput;
  vendorInTol: AuditInput;
  inputMissing: AuditInput;
};

describe("stock-db-audit-guards", () => {
  it("vendor in DIVERGENCE_TOL is not material (A P/E 26.83 vs 26.34)", () => {
    assert.equal(shouldFlagVendorGap("peRatio", 26.83, 26.34), false);
    assert.equal(shouldFlagVendorGap("returnOnEquity", 0.154, 0.1543), false);
  });

  it("vendor outside band is material", () => {
    assert.equal(shouldFlagVendorGap("peRatio", 20, 35), true);
  });

  it("missing L0 inputs lists primitives", () => {
    assert.deepEqual(missingL0Inputs("peRatio", {}, null), ["earningsPerShare", "price"]);
  });

  it("non-USD absolute field skip reason", () => {
    assert.equal(nonUsdSkipReason({ reportedCurrency: "JPY" }, "totalRevenue"), "non_usd:JPY");
    assert.equal(nonUsdSkipReason({ reportedCurrency: "JPY" }, "peRatio"), null);
  });
});

describe("stock-db-audit L0", () => {
  it("hand-check: price 100 EPS 5 → PE 20; gold 20 passes", () => {
    const exp = l0Expected("peRatio", { earningsPerShare: 5 }, 100);
    assert.equal(exp, 20);
    const r = auditL0(fixture.peIdentity);
    assert.equal(r.status, "ok");
  });

  it("flags unit_scale when margin stored as percent", () => {
    const r = auditL0(fixture.unitScale);
    assert.equal(r.class, "vendor_unit_bug");
    assert.equal(r.status, "flag");
  });

  it("flags input_missing when gold set but EPS missing", () => {
    const r = auditL0(fixture.inputMissing);
    assert.equal(r.status, "flag");
    assert.equal(r.class, "stand_in_zero");
  });

  it("skip no_l0_identity with reason code", () => {
    const r = auditL0({
      ticker: "X",
      field: "beta",
      gold: 1.2,
      price: 10,
      fund: {},
      sources: [],
      divergent: false,
      winningSource: null,
    });
    assert.equal(r.status, "skip");
    assert.equal(r.skipReason, "no_l0_identity");
  });
});

describe("stock-db-audit L1", () => {
  it("flags vendor outside materiality band", () => {
    const r = auditL1(fixture.vendorDisagree);
    assert.equal(r.status, "flag");
    assert.equal(r.class, "vendor_unit_bug");
  });

  it("does not flag vendor inside tolerance", () => {
    const r = auditL1(fixture.vendorInTol);
    assert.equal(r.status, "ok");
  });

  it("picker drift ignores immaterial replay gap", () => {
    assert.equal(shouldFlagPickerDrift("peRatio", 20, 20.001), false);
  });
});

describe("wilsonCi", () => {
  it("95% CI for 19/20", () => {
    const ci = wilsonCi(19, 20);
    assert.ok(ci.rate === 0.95);
    assert.ok(ci.lo > 0.75 && ci.hi <= 1);
  });
});
