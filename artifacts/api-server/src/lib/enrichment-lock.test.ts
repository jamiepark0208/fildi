import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ENRICHMENT_LOCK_CLASS, ENRICHMENT_LOCK_OBJ, tryWithEnrichmentLock, type LockClient } from "./enrichment-lock.ts";

function fakeClient(ok: boolean) {
  const queries: string[] = [];
  let released = false;
  const client: LockClient = {
    query: async (sql) => {
      queries.push(sql);
      return { rows: [{ ok }] };
    },
    release: () => {
      released = true;
    },
  };
  return { client, queries, released: () => released };
}

describe("enrichment advisory lock", () => {
  it("runs the job and unlocks on the same connection", async () => {
    const fake = fakeClient(true);
    let ran = false;
    const outcome = await tryWithEnrichmentLock(async () => fake.client, async () => {
      ran = true;
    });
    assert.equal(outcome, "ran");
    assert.equal(ran, true);
    assert.equal(fake.released(), true);
    assert.match(fake.queries[0], /pg_try_advisory_lock/);
    assert.match(fake.queries[1], /pg_advisory_unlock/);
    assert.equal(ENRICHMENT_LOCK_CLASS, 424242);
    assert.equal(ENRICHMENT_LOCK_OBJ, 1);
  });

  it("does not run when another process holds the lock, and still releases the connection", async () => {
    const fake = fakeClient(false);
    let ran = false;
    const outcome = await tryWithEnrichmentLock(async () => fake.client, async () => {
      ran = true;
    });
    assert.equal(outcome, "busy");
    assert.equal(ran, false);
    assert.equal(fake.released(), true);
    assert.equal(fake.queries.some((q) => q.includes("pg_advisory_unlock")), false);
  });

  it("unlocks when the job throws", async () => {
    const fake = fakeClient(true);
    await assert.rejects(
      tryWithEnrichmentLock(async () => fake.client, async () => {
        throw new Error("vendor down");
      }),
      /vendor down/,
    );
    assert.match(fake.queries[1], /pg_advisory_unlock/);
    assert.equal(fake.released(), true);
  });
});
