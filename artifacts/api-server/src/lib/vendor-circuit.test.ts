import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { VendorCircuit, isOutageError } from "./vendor-circuit.js";
import { fetchJsonWithRetry, circuitFor } from "./http-client.js";

describe("VendorCircuit (A303)", () => {
  it("opens after N outage failures inside the window, then half-opens after openMs", () => {
    const c = new VendorCircuit("t", { fails: 3, windowMs: 1_000, openMs: 5_000 });
    const t0 = 1_000_000;
    c.noteFailure(new Error("fetch failed"), t0);
    c.noteFailure(new Error("fetch failed"), t0 + 10);
    assert.equal(c.isOpen(t0 + 20), false);
    c.noteFailure(new Error("ECONNRESET"), t0 + 20);
    assert.equal(c.isOpen(t0 + 30), true);
    assert.equal(c.isOpen(t0 + 5_021), false); // half-open: next call is a probe
  });

  it("does not count failures outside the window or non-outage errors (4xx/429 are answers)", () => {
    const c = new VendorCircuit("t", { fails: 2, windowMs: 1_000, openMs: 5_000 });
    c.noteFailure(new Error("fetch failed"), 0);
    c.noteFailure(new Error("fetch failed"), 2_000);      // first one aged out
    assert.equal(c.isOpen(2_001), false);
    c.noteFailure(new Error("HTTP 404 for x"), 2_002);    // not an outage
    c.noteFailure(new Error("HTTP 429 rate limited"), 2_003);
    assert.equal(c.isOpen(2_004), false);
    assert.equal(isOutageError(new Error("HTTP 503")), true);
  });

  it("success clears the failure count", () => {
    const c = new VendorCircuit("t", { fails: 2, windowMs: 60_000, openMs: 5_000 });
    c.noteFailure(new Error("fetch failed"), 0);
    c.noteSuccess();
    c.noteFailure(new Error("fetch failed"), 1);
    assert.equal(c.isOpen(2), false);
  });
});

describe("fetchJsonWithRetry + circuit (outage drill)", () => {
  it("stops calling a vendor that drops every connection once its circuit opens", async () => {
    let connections = 0;
    const srv = createServer((sock) => { connections++; sock.destroy(); }); // every request → "fetch failed"
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const url = `http://127.0.0.1:${port}/x`;
    try {
      // first call: retries until the default circuit (3 outage failures) opens, then gives up
      await assert.rejects(fetchJsonWithRetry(url, { provider: "DrillVendor", maxRetries: 5, baseDelayMs: 1 }));
      assert.equal(connections, 3);
      assert.equal(circuitFor("DrillVendor").isOpen(), true);
      // later calls fail at once without touching the vendor
      for (let i = 0; i < 5; i++) {
        await assert.rejects(fetchJsonWithRetry(url, { provider: "DrillVendor", baseDelayMs: 1 }), /circuit open/);
      }
      assert.equal(connections, 3);
    } finally {
      srv.close();
    }
  });
});
