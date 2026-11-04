import assert from "node:assert/strict";
import test from "node:test";

test("backtest param hash is stable", async () => {
  process.env.DATABASE_URL ??= "postgres://localhost/ci";
  const { backtestParamHash } = await import("./backtest-lab.js");
  const a = backtestParamHash({ preset: "put_climax_spy_oversold", start: "2023-01-01", end: "2024-12-31" });
  const b = backtestParamHash({ end: "2024-12-31", preset: "put_climax_spy_oversold", start: "2023-01-01" });
  assert.notEqual(a, "");
  assert.equal(a, b);
});

test("A331 S151 preset reproduces breach/n (integration)", { timeout: 180_000 }, async (t) => {
  if (process.env.BACKTEST_LAB_SELF_TEST !== "1") {
    t.skip("set BACKTEST_LAB_SELF_TEST=1 with DB + s151_p4_base_cache.pkl");
  }
  process.env.DATABASE_URL ??= "postgres://localhost/fildi";
  const { runSelfTest } = await import("./backtest-lab.js");
  const r = await runSelfTest();
  assert.equal(r.ok, true, JSON.stringify(r));
  const vs = r.vsAnyDay as { n: number; breachSig: number; breachBase: number };
  assert.ok(Math.abs(vs.n - 113) <= 2, `n=${vs.n}`);
  assert.ok(Math.abs(vs.breachSig - 0.00885) < 0.002);
  assert.ok(Math.abs(vs.breachBase - 0.111) < 0.015);
});
