import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cleanSecName } from "./registry-names.js";

describe("cleanSecName", () => {
  it("title-cases all-caps SEC names and drops state suffix", () => {
    assert.equal(cleanSecName("APPLIED MATERIALS INC /DE"), "Applied Materials Inc");
    assert.equal(cleanSecName("AGILENT TECHNOLOGIES, INC."), "Agilent Technologies, Inc.");
  });
  it("keeps mixed-case words and short acronyms, fixes caps suffixes", () => {
    assert.equal(cleanSecName("TransDigm Group INC"), "TransDigm Group Inc");
    assert.equal(cleanSecName("Duke Energy CORP"), "Duke Energy Corp");
    assert.equal(cleanSecName("J M SMUCKER Co"), "J M Smucker Co");
    assert.equal(cleanSecName("Robinhood Markets, Inc."), "Robinhood Markets, Inc.");
  });
});
