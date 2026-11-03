import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
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
};

describe("stock-db-audit L0", () => {
  it("hand-check: price 100 EPS 5 → PE 20; gold 20 passes", () => {
    const exp = l0Expected("peRatio", { earningsPerShare: 5 }, 100);
    assert.equal(exp, 20);
    const r = auditL0(fixture.peIdentity);
    assert.equal(r.status, "ok");
  });

  it("flags unit_scale when margin stored as percent", () => {
    const r = auditL0(fixture.unitScale);
    assert.equal(r.class, "unit_scale");
    assert.equal(r.status, "flag");
  });
});

describe("stock-db-audit L1", () => {
  it("flags vendor outside band", () => {
    const r = auditL1(fixture.vendorDisagree);
    assert.equal(r.status, "flag");
    assert.equal(r.class, "vendor_disagreement");
  });
});

describe("wilsonCi", () => {
  it("95% CI for 19/20", () => {
    const ci = wilsonCi(19, 20);
    assert.ok(ci.rate === 0.95);
    assert.ok(ci.lo > 0.75 && ci.hi <= 1);
  });
});
