import assert from "node:assert/strict";
import test from "node:test";
import { checkAsksIndex, unindexedAskFiles } from "./check-asks-index.mjs";

test("flags a file linked in neither index", () => {
  const missing = unindexedAskFiles(
    ["A1.md", "A140.md", "A129-needs.md", "notes.md"],
    "| [A1](asks/A1.md) | 2026-10-04 | Claude → Cursor | x | open |",
    "| [A9](asks/A9.md) | 2026-10-04 | Claude → Cursor | y | done |",
  );
  assert.deepEqual(missing, ["A140.md"]);
});

test("archive-only rows are indexed", () => {
  const missing = unindexedAskFiles(
    ["A9.md"],
    "header only",
    "| [A9](asks/A9.md) | 2026-10-04 | Claude → Cursor | y | done |",
  );
  assert.deepEqual(missing, []);
});

test("live ask files are indexed", () => {
  assert.deepEqual(checkAsksIndex(), []);
});
