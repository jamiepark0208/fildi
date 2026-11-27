import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ideaPhase } from "./idea-phase.js";

describe("idea board phase", () => {
  it("keeps a planned row ready only when nobody else is blocking it", () => {
    assert.equal(ideaPhase("planned"), "reviewed");
    assert.equal(ideaPhase("planned; needs Claude: identities missing"), "filed");
    assert.equal(ideaPhase("accepted; needs Claude; needs Cursor: revise integration"), "filed");
    assert.equal(ideaPhase("partial; needs Claude: verification still open"), "filed");
  });

  it("does not treat a recent accept as in-progress work", () => {
    assert.equal(ideaPhase("accepted"), "building");
    assert.equal(ideaPhase("parked (Claude 10-29: revisit after 12-11)"), "parked");
    assert.equal(ideaPhase("done (Cursor 11-25)"), "done");
  });
});
