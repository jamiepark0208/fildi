import assert from "node:assert/strict";
import test from "node:test";
import { buildJournal, gradeOption, summarize, type JournalOrder, type PriceMap } from "./trade-journal.js";

const base = { account: "A", symbol: "XYZ", isOption: true, optionSide: "put" as const, strike: 10, expiry: "2026-11-06", fees: null };
const o = (p: Partial<JournalOrder>): JournalOrder => ({ orderId: "1", at: "2026-11-02T10:00:00Z", day: "2026-11-02", side: "credit", legEffect: "open", qty: 2, px: 0.2, ...base, ...p });
const bars = (cl: number[], lo: number[]) => cl.map((c, i) => ({ date: `2026-11-0${i + 2}`, close: c, low: lo[i] }));

test("short put expires worthless: ret = premium / strike", () => {
  const g = gradeOption({ ...base, px: 0.2, day: "2026-11-02", short: true }, bars([10.5, 10.6, 10.7, 10.8, 10.9], [10.2, 10.3, 10.4, 10.5, 10.6]));
  assert.equal(g.expired, true);
  assert.equal(g.touched, false);
  assert.ok(Math.abs((g.retPct ?? 0) - 2) < 1e-9);
});

test("short put ITM at expiry: premium minus intrinsic; strike touched", () => {
  const g = gradeOption({ ...base, px: 0.2, day: "2026-11-02", short: true }, bars([10, 9.5, 9.4, 9.3, 9.0], [9.9, 9.4, 9.3, 9.2, 8.9]));
  assert.ok(Math.abs((g.retPct ?? 0) - ((0.2 - 1) / 10) * 100) < 1e-9);
  assert.equal(g.touched, true);
});

test("split guard skips when spot differs from close > 35 %", () => {
  const g = gradeOption({ ...base, px: 0.2, day: "2026-11-02", short: true }, bars([10, 10, 10, 10, 10], [10, 10, 10, 10, 10]), 20);
  assert.equal(g.skipped, true);
});

test("FIFO: close matches open by contract; realized P&L on close row, partial remainder graded on open", () => {
  const prices: PriceMap = new Map([["XYZ", bars([10.5, 10.6, 10.7, 10.8, 10.9], [10.2, 10.3, 10.4, 10.5, 10.6])]]);
  const rows = buildJournal(
    [
      o({ orderId: "a" }),
      o({ orderId: "b", at: "2026-11-03T10:00:00Z", day: "2026-11-03", side: "debit", legEffect: "close", qty: 1, px: 0.05 }),
      o({ orderId: "c", symbol: "OTHER" }),
    ],
    prices,
  );
  const open = rows.find((r) => r.orderId === "a")!;
  const close = rows.find((r) => r.orderId === "b")!;
  assert.equal(close.matchedOpenDay, "2026-11-02");
  assert.ok(Math.abs((close.pnl ?? 0) - 15) < 1e-9); // (0.20-0.05) * 1 * 100
  assert.equal(open.status, "expired"); // 1 contract left, expired worthless
  assert.ok(Math.abs((open.pnl ?? 0) - 20) < 1e-9); // 0.2*100*1
  assert.equal(rows.find((r) => r.orderId === "c")!.pnl, null); // no prices
  const s = summarize(rows);
  assert.equal(s.trades, 2);
  assert.ok(Math.abs(s.pnl - 35) < 1e-9);
  assert.equal(s.winPct, 100);
});

test("fully closed open row is status closed and carries no remainder P&L", () => {
  const rows = buildJournal(
    [o({ orderId: "a", qty: 1 }), o({ orderId: "b", at: "2026-11-03T10:00:00Z", side: "debit", legEffect: "close", qty: 1, px: 0.5 })],
    new Map(),
  );
  assert.equal(rows[0].status, "closed");
  assert.ok(Math.abs((rows[1].pnl ?? 0) - -30) < 1e-9);
});

test("A205: open (unexpired) short put is not graded — no premium-minus-intrinsic fake mark", () => {
  const rows = buildJournal([o({ orderId: "z", expiry: "2026-11-27" })], new Map([["XYZ", bars([10.5, 10.6, 10.7, 10.8, 10.9], [10.2, 10.3, 10.4, 10.5, 10.6])]]) as PriceMap);
  const r = rows.find((x) => x.orderId === "z")!;
  assert.equal(r.status, "open");
  assert.equal(r.pnl ?? null, null);
  assert.equal(r.pct ?? null, null);
});
