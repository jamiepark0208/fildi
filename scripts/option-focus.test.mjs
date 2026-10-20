import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = readFileSync(new URL("../artifacts/api-server/src/lib/option-score-snapshots.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("focus.ts", source, ts.ScriptTarget.Latest, true);
const fn = ast.statements.find(n => n.name?.text === "attachFocus").getText(ast);

async function focus({ edges = [], trim = ["TRIM"], demoted = false, fail = "", side = "put", held = [] } = {}) {
  const context = vm.createContext({
    db: { execute: async query => {
      const q = String(query);
      if (fail && q.includes(fail)) throw new Error("fixture unavailable");
      const rows = q.includes("plan_items") ? trim.map(ticker => ({ ticker }))
        : q.includes("put_edge_status") ? [{ demoted }]
        : q.includes("portfolio_positions") ? held.map(t => ({ t })) : edges;
      return { rows };
    } },
    sql: parts => parts.join(""), num: x => x ?? null,
    FOCUS_PUTS: 10, FOCUS_CALLS: 5, logger: { warn() {} },
  });
  vm.runInContext(ts.transpile(fn, { target: ts.ScriptTarget.ES2022 }), context);
  const rows = ["TRIM", "LOW", "GOOD"].map((ticker, i) => ({ ticker, optionScore: 100 - i }));
  await context.attachFocus(rows, side);
  return rows.filter(r => r.focus).map(r => r.ticker);
}

test("observed ineligible candidates stay excluded, including partial coverage", async () => {
  assert.deepEqual(await focus({ edges: [{ ticker: "TRIM", quintile: 5 }, { ticker: "LOW", quintile: 1 }] }), []);
});
test("missing coverage falls back without trim names", async () => {
  assert.deepEqual(await focus(), ["LOW", "GOOD"]);
});
test("eligible candidates alone get Focus", async () => {
  assert.deepEqual(await focus({ edges: [{ ticker: "TRIM", quintile: 5 }, { ticker: "GOOD", quintile: 4 }] }), ["GOOD"]);
});
test("demotion keeps plain-score fallback but excludes trim", async () => {
  assert.deepEqual(await focus({ demoted: true }), ["LOW", "GOOD"]);
});
test("failed trim or edge lookup never promotes unknown eligibility", async () => {
  for (const fail of ["plan_items", "put_edge_daily"]) assert.deepEqual(await focus({ fail }), []);
});
test("covered calls require holdings; failed holdings lookup fails closed", async () => {
  assert.deepEqual(await focus({ side: "call", held: ["GOOD"] }), ["GOOD"]);
  assert.deepEqual(await focus({ side: "call", fail: "portfolio_positions" }), []);
});
