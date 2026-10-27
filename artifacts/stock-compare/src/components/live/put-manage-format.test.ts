import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatTakeAlert,
  isTakeAction,
  partitionPutManage,
  type PutManageRow,
} from "./put-manage-format.ts";

const takeRow: PutManageRow = {
  ticker: "RGTI",
  strike: 10.5,
  expiry: "2026-10-30",
  captured_pct: 62,
  pace: 4.3,
  days_held: 2,
  days_total: 7,
  action: "take + re-sell",
  why: "captured 62 % in 2 of 7 days = 4.3× plan pace ≥ 4× (S103)",
  notes: [],
  resell: [{ ticker: "MRVL", strike: 205, expiry: "2026-11-07", income_wk_pct: 0.68 }],
};

const holdRow: PutManageRow = {
  ticker: "POET",
  strike: 5,
  expiry: "2026-10-30",
  captured_pct: -74,
  pace: -1.33,
  days_held: 3,
  days_total: 7,
  action: "hold",
  why: "-74 % captured, -1.3× pace",
  notes: ["trend turned down — not a reason to close (S103: trend stops lost)"],
  resell: [],
};

describe("put-manage-format (A280)", () => {
  it("take row renders alert + re-sell ticker", () => {
    assert.equal(isTakeAction(takeRow.action), true);
    const line = formatTakeAlert(takeRow);
    assert.ok(line);
    assert.match(line!, /RGTI 10\.5p 10-30/);
    assert.match(line!, /captured 62 % in 2 of 7 days \(4\.3× plan pace\)/);
    assert.match(line!, /take profit/);
    assert.match(line!, /re-sell MRVL 205p \(0\.68 %\/wk\)/);
  });

  it("hold rows raise no alert", () => {
    assert.equal(isTakeAction(holdRow.action), false);
    assert.equal(formatTakeAlert(holdRow), null);
    const { takes, holds } = partitionPutManage([takeRow, holdRow, holdRow]);
    assert.equal(takes.length, 1);
    assert.equal(holds.length, 2);
    assert.equal(takes.every((r) => formatTakeAlert(r) != null), true);
    assert.equal(holds.every((r) => formatTakeAlert(r) == null), true);
  });
});
