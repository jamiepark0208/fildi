import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { singleFlight } from "./single-flight.ts";

describe("singleFlight", () => {
  it("shares one run among concurrent callers, then allows a new run", async () => {
    let runs = 0;
    const go = singleFlight(async () => { runs++; await new Promise(r => setTimeout(r, 20)); return runs; });
    const [a, b] = await Promise.all([go(), go()]);
    assert.equal(runs, 1);
    assert.equal(a, b);
    await go();
    assert.equal(runs, 2);
  });

  it("propagates errors to all waiters and resets", async () => {
    let runs = 0;
    const go = singleFlight(async () => { runs++; throw new Error("boom"); });
    const results = await Promise.allSettled([go(), go()]);
    assert.equal(runs, 1);
    assert.ok(results.every(r => r.status === "rejected"));
    await assert.rejects(go());
    assert.equal(runs, 2);
  });
});
