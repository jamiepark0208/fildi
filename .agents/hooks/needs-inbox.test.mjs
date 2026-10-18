import assert from "node:assert/strict";
import test from "node:test";
import { detectInboxAgent, splitInboxDelivery } from "./needs-inbox.mjs";

test("short comments are all delivered", () => {
  const rows = [
    { id: "1", item: "J1", body: "hi" },
    { id: "2", item: "A140", body: "there" },
  ];
  const { delivered, undelivered } = splitInboxDelivery(rows, 1500);
  assert.deepEqual(delivered.map((r) => r.id), ["1", "2"]);
  assert.equal(undelivered.length, 0);
});

test("budget cuts the tail and does not deliver later rows", () => {
  const rows = [
    { id: "1", item: "J1", body: "short" },
    { id: "2", item: "J2", body: "y".repeat(300) },
    { id: "3", item: "J3", body: "later" },
  ];
  const { delivered, undelivered } = splitInboxDelivery(rows, 40);
  assert.deepEqual(delivered.map((r) => r.id), ["1"]);
  assert.deepEqual(undelivered.map((r) => r.id), ["2", "3"]);
  const used = delivered.reduce((s, r) => s + r.line.length, 0);
  assert.ok(used <= 40);
});

test("ten long comments only print what fits in 1500 chars", () => {
  const body = "x".repeat(300);
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: String(i + 1), item: `J${i + 1}`, body }));
  const { delivered, undelivered } = splitInboxDelivery(rows, 1500);
  assert.ok(delivered.length >= 1 && delivered.length < rows.length);
  assert.equal(delivered.length + undelivered.length, rows.length);
  const used = delivered.reduce((s, r) => s + r.line.length, 0);
  assert.ok(used <= 1500);
  const next = undelivered[0];
  const nextLine = `[NEEDS YOU ${next.item}] Jamie: ${String(next.body).slice(0, 300)}`;
  assert.ok(used + nextLine.length > 1500);
});

test("detectInboxAgent: --agent flag and FILDI_AGENT beat Cursor env", () => {
  assert.equal(detectInboxAgent({ FILDI_AGENT: "muse" }, {}, ["node", "needs-inbox.mjs"]), "muse");
  assert.equal(detectInboxAgent({}, {}, ["node", "x", "--agent=cursor"]), "cursor");
  assert.equal(detectInboxAgent({ CURSOR_TRACE_ID: "1" }, {}, ["node", "x"]), "cursor");
  assert.equal(detectInboxAgent({}, { cursor_version: "1" }, ["node", "x"]), "cursor");
  assert.equal(detectInboxAgent({}, {}, ["node", "x"]), "claude");
});
