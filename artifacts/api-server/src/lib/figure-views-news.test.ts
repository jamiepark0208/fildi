import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchFigureFromText } from "./figure-views-ingest.js";

describe("A85 matchFigureFromText", () => {
  it("matches full names", () => {
    assert.equal(matchFigureFromText("Mohamed El-Erian warns on rates"), "el-erian");
    assert.equal(matchFigureFromText("Tom Lee of Fundstrat lifts SPX target"), "tom-lee");
  });
  it("matches distinctive last names", () => {
    assert.equal(matchFigureFromText("Gundlach sees recession"), "gundlach");
    assert.equal(matchFigureFromText("Powell signals cut"), "fed-powell");
  });
  it("returns null when no figure", () => {
    assert.equal(matchFigureFromText("Markets rally on CPI"), null);
  });
});
