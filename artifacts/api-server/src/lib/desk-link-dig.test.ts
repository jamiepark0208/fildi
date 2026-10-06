import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractDigFactsFromText,
  formatDigFactsForPrompt,
  isShallowDigFact,
  mergePreferRichDigFacts,
  unwrapPstmrkUrl,
} from "./desk-link-dig.ts";

describe("desk-link-dig", () => {
  it("unwraps TipRanks pstmrk stock URLs", () => {
    const raw =
      "https://track.pstmrk.it/3s/www.tipranks.com*2Fstocks*2FOKLO*3Fref*3Ddaily-digest/enfm/I3-IAQ/AQ/x";
    const u = unwrapPstmrkUrl(raw);
    assert.match(u, /tipranks\.com\/stocks\/OKLO/i);
  });

  it("extracts analyst ratings from TipRanks watchlist body", () => {
    const body = `
Today's Updates on Your TipRanks Stock Watchlist
Analyst Ratings
- Oklo Inc (OKLO)
- 1 new analyst ratings published
- Tesla (TSLA)
- 1 new analyst ratings published
Visit your notification center
`;
    const facts = extractDigFactsFromText(body, "tipranks");
    assert.deepEqual(facts.map((f) => f.ticker).sort(), ["OKLO", "TSLA"]);
    assert.ok(facts.every((f) => f.kind === "analyst_rating"));
    assert.ok(facts.every(isShallowDigFact));
  });

  it("extracts TipRanks markdown lists with URL lines between ticker and rating", () => {
    const body = `
   - SpaceX (SPCX) 
   <https://track.pstmrk.it/3s/www.tipranks.com*2Fstocks*2FSPCX>
   - 1 new analyst ratings published 
   - Alphabet Class A (GOOGL) 
   <https://example.com>
   - 1 new analyst ratings published 
`;
    const facts = extractDigFactsFromText(body, "tipranks");
    assert.deepEqual(facts.map((f) => f.ticker).sort(), ["GOOGL", "SPCX"]);
  });

  it("extracts price targets", () => {
    const facts = extractDigFactsFromText("NVDA price target raised to $240 by Street", "sa");
    assert.ok(facts.some((f) => f.ticker === "NVDA" && f.kind === "price_target"));
  });

  it("mergePreferRichDigFacts drops shallow when rich exists for ticker", () => {
    const merged = mergePreferRichDigFacts(
      [{ ticker: "GOOGL", kind: "analyst_rating", detail: "1 new analyst rating(s)", source: "tipranks" }],
      [{
        ticker: "GOOGL",
        kind: "analyst_rating",
        detail: "Wells Fargo maintain Overweight (2026-10-06)",
        source: "yahoo",
      }],
    );
    assert.equal(merged.length, 1);
    assert.match(merged[0]!.detail, /Wells Fargo/);
    assert.equal(isShallowDigFact(merged[0]!), false);
  });

  it("rejects prose false-positive tickers like TO from upgraded to Buy", () => {
    const facts = extractDigFactsFromText("Analyst upgraded to Buy on the name", "sa");
    assert.ok(!facts.some((f) => f.ticker === "TO"));
  });

  it("formatDigFactsForPrompt omits shallow and warns incomplete", () => {
    const block = formatDigFactsForPrompt([
      { ticker: "SPCX", kind: "analyst_rating", detail: "1 new analyst rating(s)", source: "tipranks" },
      {
        ticker: "GOOGL",
        kind: "analyst_rating",
        detail: "Wells Fargo maintain Overweight (2026-10-06)",
        source: "yahoo",
      },
    ]);
    assert.match(block, /Wells Fargo/);
    assert.match(block, /INCOMPLETE/);
    assert.match(block, /SPCX/);
    assert.doesNotMatch(block, /1 new analyst rating\(s\)/);
  });
});
