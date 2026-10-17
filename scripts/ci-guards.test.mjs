import assert from "node:assert/strict";
import test from "node:test";
import {
  guardRange,
  hasAgentTrailer,
  isMergeCommit,
  protectedHits,
  schemaWithoutMigration,
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
    files: [],
    commits: [{ hash: "abc1234dead", parents: ["a"], message: "fix a bug\n" }],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Agent/);
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
