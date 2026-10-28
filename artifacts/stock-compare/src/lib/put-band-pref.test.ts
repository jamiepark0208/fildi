import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { putBandPrefLabel, putBandSegmentActive, parsePutBandError } from "./put-band-pref.ts";

describe("putBandPrefLabel", () => {
  it("labels auto, shift, and fixed", () => {
    assert.equal(putBandPrefLabel({ mode: "auto" }), "Auto (engine)");
    assert.equal(putBandPrefLabel({ mode: "shift", steps: -1 }), "Farther -1");
    assert.equal(putBandPrefLabel({ mode: "shift", steps: 2 }), "Closer +2");
    assert.equal(putBandPrefLabel({ mode: "fixed", band: "0.10-0.12" }), "Fixed 0.10-0.12Δ");
  });
});

describe("putBandSegmentActive", () => {
  it("matches segment to pref", () => {
    assert.equal(putBandSegmentActive({ mode: "auto" }, "auto"), true);
    assert.equal(putBandSegmentActive({ mode: "shift", steps: -1 }, -1), true);
    assert.equal(putBandSegmentActive({ mode: "shift", steps: -1 }, -2), false);
    assert.equal(putBandSegmentActive({ mode: "fixed", band: "0.08-0.10" }, "fixed"), true);
  });
});

describe("parsePutBandError", () => {
  it("reads API error string", () => {
    assert.match(parsePutBandError({ error: "pref must be …" }), /pref must/);
    assert.equal(parsePutBandError(null), "Could not save put band");
  });
});
