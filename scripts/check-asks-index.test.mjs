import assert from "node:assert/strict";
import test from "node:test";
import { askIndexProblems, checkAsksIndex, unindexedAskFiles } from "./check-asks-index.mjs";

test("duplicate task IDs cannot silently merge two owners' work", () => {
  const rows = "| [A1](asks/A1.md) | Claude | task one |\n| [A1](asks/A1.md) | Muse | task two |";
  assert.deepEqual(askIndexProblems(["A1.md"], rows, ""), [
    "ASKS.md:2: duplicate A1; first at ASKS.md:1",
  ]);
});

test("duplicates across archive and active index are reported", () => {
  const row = "| [A1](asks/A1.md) | task |";
  assert.match(askIndexProblems(["A1.md"], row, row)[0], /ASKS-archive.md:1: duplicate A1/);
});

test("wrong link targets and missing files are reported", () => {
  assert.deepEqual(askIndexProblems([], "| [A1](asks/A2.md) | task |", ""), [
    "ASKS.md:1: A1 links to A2.md", "ASKS.md:1: missing asks/A2.md",
  ]);
});

test("valid archived tasks and prose references do not collide", () => {
  assert.deepEqual(askIndexProblems(["A1.md", "A2.md"],
    "| [A1](asks/A1.md) | task |\nSee [A1](asks/A1.md).",
    "| [A2](asks/A2.md) | closed |"), []);
});

test("noncanonical targets cannot silently bypass integrity checks", () => {
  assert.match(askIndexProblems([], "| [A1](asks/missing.md) | task |", "")[0], /invalid task target/);
  assert.match(askIndexProblems(["A2.md"], "| [A1](./asks/A2.md) | task |", "")[0], /A1 links to A2.md/);
  assert.match(askIndexProblems([], "| [A1](../private.md) | task |", "")[0], /invalid task target/);
});

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
