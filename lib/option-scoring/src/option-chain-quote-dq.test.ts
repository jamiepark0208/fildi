import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assessOptionChainQuoteDq } from "./option-chain-quote-dq.ts";

describe("assessOptionChainQuoteDq", () => {
  it("flags Schwab zero live bids as DQ fail", () => {
    const dq = assessOptionChainQuoteDq([{
      source: "schwab",
      puts: [
        { bid: 0, ask: 0.4, bidIsLive: false, meetsGate: false },
        { bid: 0, ask: 0.2, bidIsLive: false, meetsGate: false },
      ],
      calls: [],
    }], false);
    assert.equal(dq.code, "zero_bids_schwab");
    assert.equal(dq.degraded, true);
    assert.equal(dq.withAskNoBid, 2);
    assert.match(dq.message, /Schwab/);
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
