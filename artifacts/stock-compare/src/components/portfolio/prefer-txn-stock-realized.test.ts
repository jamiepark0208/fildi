import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { preferTxnStockRealized } from "./prefer-txn-stock-realized.ts";

describe("preferTxnStockRealized (A259)", () => {
  it("keeps export and flags when signs disagree (+1000 vs −1200)", () => {
    assert.deepEqual(preferTxnStockRealized(1000, -1200), { value: 1000, mixed: true });
  });

  it("replaces when signs agree and |txn| larger (+1000 vs +1200)", () => {
    assert.deepEqual(preferTxnStockRealized(1000, 1200), { value: 1200, mixed: false });
  });

  it("uses txn when export is zero (0 vs −50)", () => {
    assert.deepEqual(preferTxnStockRealized(0, -50), { value: -50, mixed: false });
  });

  it("replaces under-reported same-sign loss (−100 vs −1200)", () => {
    assert.deepEqual(preferTxnStockRealized(-100, -1200), { value: -1200, mixed: false });
  });

  it("keeps export when |txn| is not larger", () => {
    assert.deepEqual(preferTxnStockRealized(1000, 500), { value: 1000, mixed: false });
  });
});
