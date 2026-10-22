import assert from "node:assert/strict";
import test from "node:test";
import {
  guardRange,
  hasAgentTrailer,
  isCommentaryOnly,
  isMergeCommit,
  newComponentOverLimit,
  protectedHits,
  schemaWithoutMigration,
  scoreChangeApproved,
  scoringPathHits,
} from "./ci-guards.mjs";

test("protected paths", () => {
  assert.deepEqual(protectedHits(["artifacts/macro-data.json", "README.md"]), ["artifacts/macro-data.json"]);
  assert.deepEqual(protectedHits([".claude/state.json", "artifacts/macro-charts.json"]), [
    ".claude/state.json",
    "artifacts/macro-charts.json",
  ]);
});

test("Agent trailer survives a blank line before Co-authored-by", () => {
  // Fixture only. pull_request checkout HEAD is GitHub's synthetic merge and has no Agent line.
  assert.equal(hasAgentTrailer("subject\n\nbody\n\nAgent: grokbot\n\nCo-authored-by: dev <dev@example.com>\n"), true);
  assert.equal(hasAgentTrailer("We set Agent: grokbot in the docs.\n\nCo-authored-by: dev <dev@example.com>\n"), false);
  assert.equal(hasAgentTrailer("fix\n\nAgent:\n"), false);
});

test("merge commits are skipped", () => {
  assert.equal(isMergeCommit(["a", "b"]), true);
  assert.equal(isMergeCommit(["a"]), false);
  const errors = guardRange({
    files: [],
    commits: [{ hash: "abc1234dead", parents: ["a", "b"], message: "Merge branch 'cursor/mac-dev'\n" }],
  });
  assert.deepEqual(errors, []);
});

test("non-merge commit without Agent fails", () => {
  const errors = guardRange({
    files: ["scripts/ci-guards.mjs"],
    commits: [{ hash: "abc1234dead", parents: ["a"], message: "fix a bug\n", files: ["scripts/ci-guards.mjs"] }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Agent/);
});

test("A197: commentary-only commits skip Agent trailer", () => {
  assert.equal(isCommentaryOnly(["commentary/latest-am.md", "commentary/2026-10-20-am.md"]), true);
  assert.equal(isCommentaryOnly(["commentary/latest-am.md", "scripts/ci-guards.mjs"]), false);
  assert.equal(isCommentaryOnly([]), false);
  const errors = guardRange({
    files: ["commentary/latest-am.md"],
    commits: [{
      hash: "abc1234dead",
      parents: ["a"],
      message: "commentary: morning brief\n",
      files: ["commentary/latest-am.md", "commentary/2026-10-20-am.md"],
    }],
  });
  assert.deepEqual(errors, []);
});

test("schema change needs a drizzle sql file in the same range", () => {
  assert.deepEqual(schemaWithoutMigration(["lib/db/src/schema/index.ts"]), ["lib/db/src/schema/index.ts"]);
  assert.deepEqual(
    schemaWithoutMigration(["lib/db/src/schema/index.ts", "lib/db/drizzle/0029_example.sql"]),
    [],
  );
  assert.deepEqual(schemaWithoutMigration(["lib/db/sql/app_config.sql"]), []);
  assert.deepEqual(schemaWithoutMigration(["lib/db/drizzle/meta/_journal.json"]), []);
});

test("A145: scoring path tripwire needs approval", () => {
  assert.deepEqual(
    scoringPathHits(["artifacts/api-server/src/lib/technical-scorer-v2.ts", "README.md"]),
    ["artifacts/api-server/src/lib/technical-scorer-v2.ts"],
  );
  assert.equal(scoreChangeApproved({ messages: ["fix\n\nApproved-score-change: retune W_rsi\n"] }), true);
  assert.equal(scoreChangeApproved({ prBody: "Please add needs-jamie label" }), true);
  assert.equal(scoreChangeApproved({ messages: ["docs only\n"] }), false);
});

test("A145: new component line cap is 150", () => {
  const counts = {
    "artifacts/stock-compare/src/components/Foo.tsx": 151,
    "artifacts/stock-compare/src/components/Bar.tsx": 150,
    "artifacts/stock-compare/src/components/Foo.test.tsx": 200,
    "scripts/long.py": 400,
  };
  const bad = newComponentOverLimit(Object.keys(counts), (f) => counts[f] ?? 0);
  assert.deepEqual(bad, [{ file: "artifacts/stock-compare/src/components/Foo.tsx", lines: 151 }]);
});
