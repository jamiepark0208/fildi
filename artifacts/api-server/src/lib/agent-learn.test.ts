import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildTurnsFromEvents, parseAskId, rollups24h } from "./agent-learn.js";

describe("agent-learn A209 P0", () => {
  it("parseAskId from Refs trailer text", () => {
    assert.equal(parseAskId("ship it Refs: A209"), "A209");
    assert.equal(parseAskId("no ask here"), null);
  });

  it("one prompt + tools + stop → one turn with tool counts", () => {
    const turns = buildTurnsFromEvents([
      { t: "2026-10-21T10:00:00.000Z", agent: "cursor", session: "s1", event: "prompt", detail: "fix A197 Refs: A197" },
      { t: "2026-10-21T10:00:05.000Z", agent: "cursor", session: "s1", event: "tool", tool: "Read", kind: "reading", detail: "scripts/ci-guards.mjs" },
      { t: "2026-10-21T10:00:10.000Z", agent: "cursor", session: "s1", event: "tool", tool: "Shell", kind: "other", detail: "bash scripts/agent-ship-check.sh" },
      { t: "2026-10-21T10:00:20.000Z", agent: "cursor", session: "s1", event: "edit", tool: "Edit", kind: "code", detail: "scripts/ci-guards.mjs" },
      { t: "2026-10-21T10:01:00.000Z", agent: "cursor", session: "s1", event: "stop" },
    ]);
    assert.equal(turns.length, 1);
    const t = turns[0]!;
    assert.equal(t.agent, "cursor");
    assert.ok(t.tools >= 1);
    assert.equal(t.ask_id, "A197");
    assert.equal(t.outcome, "ok");
    assert.ok(t.ship_checks >= 1);
    assert.equal(t.ship_ok, true);
  });

  it("rollups24h aggregates fail_pct", () => {
    const now = new Date().toISOString();
    const r = rollups24h([
      {
        id: "a", agent: "cursor", session: "s", t0: now, t1: now, wall_s: 1, prompt: "x", ask_id: null,
        in_tok: null, out_tok: null, cache_read: null, tools: 2, reads: 1, writes: 0, bash: 0, mcp: 0, edits: 0,
        oj_asks: 0, unique_files: 0, reread_same: 0, loop_hits: 0, fails: 1, ship_checks: 0, ship_ok: null,
        commits: 0, outcome: "fail",
      },
      {
        id: "b", agent: "cursor", session: "s", t0: now, t1: now, wall_s: 1, prompt: "y", ask_id: null,
        in_tok: null, out_tok: null, cache_read: null, tools: 1, reads: 0, writes: 0, bash: 0, mcp: 0, edits: 0,
        oj_asks: 0, unique_files: 0, reread_same: 0, loop_hits: 0, fails: 0, ship_checks: 0, ship_ok: null,
        commits: 1, outcome: "ok",
      },
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.fail_pct, 50);
  });
});
