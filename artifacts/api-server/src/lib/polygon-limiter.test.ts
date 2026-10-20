import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const GATE = "/tmp/fildi-logs/polygon.gate";
const LOCK = `${GATE}.lock`;

describe("polygon gate file (A185)", () => {
  it("stamp file is writable under /tmp/fildi-logs", () => {
    mkdirSync(dirname(GATE), { recursive: true });
    try {
      unlinkSync(LOCK);
    } catch {
      /* none */
    }
    writeFileSync(GATE, "1.0", "utf8");
    assert.equal(readFileSync(GATE, "utf8").trim(), "1.0");
  });
});
