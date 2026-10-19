import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessOptionChainQuoteDq } from "./option-chain-quote-dq.ts";

describe("assessOptionChainQuoteDq", () => {
  it("flags Schwab zero live bids as DQ fail and names ask-only strikes", () => {
    const dq = assessOptionChainQuoteDq([{
      source: "schwab",
      expiry: "2026-10-21",
      puts: [
        { bid: 0, ask: 0.4, bidIsLive: false, meetsGate: false, strike: 300 },
        { bid: 0, ask: 0.2, bidIsLive: false, meetsGate: false, strike: 295 },
      ],
      calls: [],
    }], false);
    assert.equal(dq.code, "zero_bids_schwab");
    assert.equal(dq.degraded, true);
    assert.equal(dq.withAskNoBid, 2);
    assert.match(dq.message, /Schwab/);
    assert.match(dq.message, /\$300P/);
    assert.deepEqual(dq.askOnlySamples, ["2026-10-21 $300P", "2026-10-21 $295P"]);
  });

  it("empty OTM band includes spot strike range hint", () => {
    const dq = assessOptionChainQuoteDq([{
      source: "schwab",
      spot: 1.46,
      puts: [],
      calls: [],
    }], false);
    assert.equal(dq.code, "empty");
    assert.match(dq.message, /\$0\.88/); // sub-$10 → 40% max OTM
    assert.match(dq.message, /\$1\.42/);
  });

  it("warns on Yahoo fallback even with bids", () => {
    const dq = assessOptionChainQuoteDq([{
      source: "yahoo",
      puts: [{ bid: 0.5, ask: 0.6, bidIsLive: true, meetsGate: true }],
      calls: [],
    }], false);
    assert.equal(dq.code, "yahoo_fallback");
    assert.equal(dq.degraded, true);
  });

  it("ok for Schwab with live bids", () => {
    const dq = assessOptionChainQuoteDq([{
      source: "schwab",
      puts: [{ bid: 0.5, ask: 0.6, bidIsLive: true, meetsGate: true }],
      calls: [],
    }], false);
    assert.equal(dq.code, "ok");
    assert.equal(dq.degraded, false);
  });
});
