import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { allocate, optionSource, rankSources, stockSource, type Account, type StockIn } from "./capital-plan.js";

const stk = (over: Partial<StockIn>): StockIn => ({ account: "A", ticker: "X", qty: 100, px: 10, avgCost: 10, folder: null, verdict: null,
  p2f: null, offHigh: -0.5, support: 9, resistance: 12, lockedShares: 0, ...over });

describe("capital plan", () => {
  it("sells Model List avoid before green, tax loss first inside a tier", () => {
    const src = [stockSource(stk({ ticker: "G", verdict: "green", folder: "own" }), true)!,
      stockSource(stk({ ticker: "R1", folder: "avoid", avgCost: 8 }), true)!,
      stockSource(stk({ ticker: "R2", folder: "avoid", avgCost: 20 }), true)!];
    assert.deepEqual(rankSources(src).map((s) => s.ticker), ["R2", "R1", "G"]);
  });

  it("repays a margin loan first and shares cash across recs; never drops a rec", () => {
    const accts: Account[] = [{ account: "A", name: "FILDI", cash: -1000, loan: 1000, taxable: true }];
    const src = [stockSource(stk({ ticker: "R", folder: "avoid" }), true)!];   // $1,000
    const p = allocate(accts, src, [{ id: "a", account: "A", ticker: "N", need: 500 }, { id: "b", account: "A", ticker: "M", need: 100 }]);
    assert.equal(p.get("a")!.fits, false);
    assert.equal(p.get("a")!.shortBy, 500);           // $1,000 sale only clears the loan
    assert.match(p.get("a")!.note ?? "", /margin loan/);
    assert.equal(p.get("b")!.shortBy, 100);           // a's failure did not spend the sale
  });

  it("an earlier funded rec uses up the cash for a later one", () => {
    const accts: Account[] = [{ account: "I", name: "IRA", cash: 600, loan: 0, taxable: false }];
    const p = allocate(accts, [], [{ id: "a", account: "I", ticker: "N", need: 500 }, { id: "b", account: "I", ticker: "M", need: 500 }]);
    assert.equal(p.get("a")!.fits, true);
    assert.equal(p.get("b")!.shortBy, 400);
  });

  it("flags a rec that only fits from an earlier rec's leftover sale cash", () => {
    const accts: Account[] = [{ account: "I", name: "IRA", cash: 0, loan: 0, taxable: false }];
    const src = [stockSource(stk({ account: "I", ticker: "R", folder: "avoid", qty: 1000 }), false)!];   // $10,000
    const p = allocate(accts, src, [{ id: "a", account: "I", ticker: "N", need: 2000 }, { id: "b", account: "I", ticker: "M", need: 3000 }]);
    assert.equal(p.get("a")!.note, null);
    assert.equal(p.get("b")!.fits, true);
    assert.match(p.get("b")!.note ?? "", /left over/);
  });

  it("skips the call being funded, closes ≥ 50 % captured puts first", () => {
    const accts: Account[] = [{ account: "I", name: "IRA", cash: 0, loan: 0, taxable: false }];
    const call = optionSource({ account: "I", ticker: "N", type: "call", dir: "long", strike: 165, expiry: "2026-12-24", qty: 1, mark: 5, cost: 6, pBe: 0.1 }, false)!;
    const put = optionSource({ account: "I", ticker: "Z", type: "put", dir: "short", strike: 10, expiry: "2026-12-04", qty: 1, mark: 0.1, cost: 0.5, pBe: null }, false)!;
    const p = allocate(accts, [call, put], [{ id: "a", account: "I", ticker: "N", need: 900, excludeKeys: [call.key] }]);
    assert.deepEqual(p.get("a")!.sells.map((s) => s.what), ["buy back Z 10P 12-04 ×1"]);
    assert.equal(p.get("a")!.fits, false);
    assert.equal(p.get("a")!.shortBy, 0);
  });
});
