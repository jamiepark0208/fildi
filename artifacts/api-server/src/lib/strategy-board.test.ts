import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { parseBoard, s159Chip } from "./strategy-board.ts";

const boardPath = join(dirname(fileURLToPath(import.meta.url)), "../../../../research/studies/BOARD.md");

describe("strategy board", () => {
  it("reads the current Works and Dead tables", () => {
    const board = parseBoard(readFileSync(boardPath, "utf8"));
    assert.equal(board.works.length, 10);
    assert.equal(board.underpowered.length, 3);
    assert.ok(board.dead.length >= 20);
    assert.ok(board.testing.length >= 4);
    assert.match(board.underpowered[0].study, /S159/);
  });

  it("fires the S159 chip when QQQ RSI is forced to 24", () => {
    const chip = s159Chip(40, 24);
    assert.ok(chip);
    assert.equal(chip.tone, "fire");
    assert.match(chip.text, /QQQ RSI 24\.0/);
    assert.equal(s159Chip(30, 30), null);
    assert.equal(s159Chip(26.4, 40)?.tone, "near");
  });
});
