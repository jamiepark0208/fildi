import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guardFacts, numberTokens, sourceTier } from "./desk-facts.js";

const BODY = "Alphabet (GOOGL) Search revenue +12% vs +15% consensus; backlog $1,250.50 B. Acme Corp (ACMQ) won a contract.";
const U = new Set(["GOOGL", "META"]);

describe("desk-facts guard", () => {
  it("normalises number tokens", () => {
    assert.deepEqual(numberTokens("$1,250.50 B and 3.70% and 12"), ["1250.5", "3.7", "12"]);
  });

  it("keeps a fact whose numbers are all in the email", () => {
    const r = guardFacts([{ kind: "earnings_detail", tickers: ["googl"], claim: "Search +12% vs +15% cons", numbers: ["+12%", "+15%"] }], BODY, U);
    assert.equal(r.facts.length, 1);
    assert.deepEqual(r.facts[0]!.tickers, ["GOOGL"]);
  });

  it("drops a fact with a number not in the email (invented / computed)", () => {
    const r = guardFacts([{ kind: "earnings_detail", tickers: ["GOOGL"], claim: "Search missed by 3 points", numbers: ["3"] }], BODY, U);
    assert.equal(r.facts.length, 0);
    assert.equal(r.dropped.numbers, 1);
  });

  it("drops unknown kinds and tickers neither in the universe nor in the email", () => {
    const r = guardFacts([
      { kind: "rumour", tickers: [], claim: "x", numbers: [] },
      { kind: "corporate_event", tickers: ["ACMQ", "ZZZZ", "META"], claim: "Acme won a contract", numbers: [] },
    ], BODY, U);
    assert.equal(r.dropped.kind, 1);
    assert.deepEqual(r.facts[0]!.tickers, ["ACMQ", "META"]);
    assert.equal(r.dropped.tickers, 1);
  });

  it("tiers sources per the skill table", () => {
    assert.equal(sourceTier("factset_streetaccount", "us_market_recap", ""), "A");
    assert.equal(sourceTier("tipranks", "tipranks", "These 2 'Strong Buy' Energy Stocks"), "D");
    assert.equal(sourceTier("tipranks", "tipranks", "A Stock on Your Watchlist Has New Activity"), "C");
    assert.equal(sourceTier("bloomberg", "bloomberg", "Five Things"), "B");
  });
});

describe("desk-facts chunking", () => {
  it("splits on lines and keeps every line", async () => {
    const { chunkText } = await import("./desk-facts.js");
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const parts = chunkText(text, 200);
    assert.ok(parts.length > 5 && parts.every((p) => p.length <= 200));
    assert.equal(parts.join("\n"), text);
  });
});

describe("desk-facts list pass", () => {
  it("reads wrapped earnings-timing lists, skips prose", async () => {
    const { listFacts } = await import("./desk-facts.js");
    const u = new Set<string>();
    const text = "Tuesday, Oct 27\n • Post-close: AAT, ACGL, BKR,\nCAKE, ENPH\nThe Post-market session was quiet for STX holders today\n • Pre-market: STX";
    const f = listFacts(text, u);
    assert.equal(f.length, 1);
    assert.deepEqual(f[0]!.tickers, ["AAT", "ACGL", "BKR", "CAKE", "ENPH"]);
    assert.match(f[0]!.claim, /^Tuesday, Oct 27 · Post-close: these companies report/);
  });
});
