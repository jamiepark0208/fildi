import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { claimNamesFirm, listFactDate, parseAnalystClaim, resolveAnalyst, resolveCalendar } from "./desk-fact-resolve.js";

const row = (firm: string, action: string, pt: string | null, to_grade = "Buy") =>
  ({ firm, action, to_grade, event_date: "2026-10-30", price_target: pt, source: "yahoo" });

describe("desk-fact-resolve analyst", () => {
  it("parses direction and new/old PT", () => {
    assert.deepEqual(parseAnalystClaim("Cantor Fitzgerald cut Alphabet target to $350 from $420, overweight."), { action: "pt", pt: 350, priorPt: 420 });
    assert.deepEqual(parseAnalystClaim("Susquehanna lowered SanDisk price target to $2,720 from $2,745 after results."), { action: "pt", pt: 2720, priorPt: 2745 });
    assert.equal(parseAnalystClaim("Wolfe Research initiated Dick's at outperform, $181 target, 27% upside from $141.97").pt, 181);
    assert.equal(parseAnalystClaim("Citizens downgraded Alphabet to market perform").action, "down");
    assert.equal(parseAnalystClaim("Truist maintains Hold on Tesla; target $370, DCF based.").pt, 370);
  });

  it("matches firm names across spellings", () => {
    assert.ok(claimNamesFirm("JPMorgan raised NVDA target", "JP Morgan"));
    assert.ok(claimNamesFirm("BofA lifts target", "B of A Securities"));
    assert.ok(claimNamesFirm("Tesla RBC Capital maintains outperform", "RBC Capital"));
    assert.ok(claimNamesFirm("TD Cowen maintains buy on Lam", "TD Cowen"));
    assert.ok(!claimNamesFirm("Goldman Sachs upgraded OXY", "Morgan Stanley"));
    assert.ok(!claimNamesFirm("Berenberg raised Eli Lilly target, citing obesity demand", "Citigroup"));
    assert.ok(claimNamesFirm("Citi cut INTC target", "Citigroup"));
    assert.ok(!claimNamesFirm("Stifel maintains Hold on Kinder Morgan, target $35", "Morgan Stanley"));
    assert.ok(claimNamesFirm("Cantor cut Alphabet target to $350", "Cantor Fitzgerald"));
  });

  it("agree on PT within 1 %, disagree on PT or direction, none when the firm is missing", () => {
    const claim = "Cantor Fitzgerald cut Alphabet target to $350 from $420, overweight.";
    assert.equal(resolveAnalyst(claim, [row("Cantor Fitzgerald", "main", "350")]).verdict, "agree");
    assert.equal(resolveAnalyst(claim, [row("Cantor Fitzgerald", "main", "380")]).verdict, "disagree");
    assert.equal(resolveAnalyst("Citizens downgraded Alphabet to market perform", [row("Citizens", "up", null)]).verdict, "disagree");
    assert.equal(resolveAnalyst(claim, [row("UBS", "main", "350")]).verdict, "none");
    assert.equal(resolveAnalyst("JPMorgan upgraded Palantir to overweight with $262 target", [row("JP Morgan", "init", "262")]).verdict, "agree");
    assert.equal(resolveAnalyst("Rocket Lab USA (RKLB): 1 new analyst rating published", []).verdict, "n/a");
  });
});

describe("desk-fact-resolve calendar", () => {
  it("reads the report day from list claims", () => {
    assert.equal(listFactDate("Monday 2-Nov · Earnings: these companies report", "2026-10-30"), "2026-11-02");
    assert.equal(listFactDate("Tuesday, Oct 27 · Post-close: these companies report", "2026-10-23"), "2026-10-27");
    assert.equal(listFactDate("Monday · Post-market: these companies report", "2026-10-30"), "2026-11-02");
    assert.equal(listFactDate("After the close: these companies report", "2026-11-02"), "2026-11-02");
    assert.equal(listFactDate("Monday 04-Jan · Pre-open: these companies report", "2026-12-30"), "2027-01-04");
    assert.equal(listFactDate("Friday. $44B of 7-year notes on Thursday. · After the close: these companies report", "2026-10-27"), "2026-10-27");
  });

  it("agree / disagree / none per ticker", () => {
    const ours = new Map([["AAPL", ["2026-11-02"]], ["NVDA", ["2026-11-17"]], ["PGR", ["2026-10-14"]]]);
    const r = resolveCalendar("2026-11-02", ["AAPL", "NVDA", "ZZZ", "PGR"], ours, "2026-10-30");
    assert.equal(r.verdict, "disagree");
    assert.deepEqual(r.ourValue, { date: "2026-11-02", agree: 1, none: 1, pastOnly: 1, disagree: [{ t: "NVDA", ours: ["2026-11-17"] }], nDisagree: 1 });
    assert.equal(resolveCalendar("2026-11-02", ["AAPL", "PGR"], ours, "2026-10-30").verdict, "agree");
  });
});

describe("desk-fact-resolve firm", () => {
  it("reads the broker from desk claims", async () => {
    const { parseFirm } = await import("./desk-fact-resolve.js");
    assert.equal(parseFirm("Cantor Fitzgerald (Deepak Mathivanan) raised Meta target to $860 from $840"), "Cantor Fitzgerald");
    assert.equal(parseFirm("Instacart downgraded to equal weight from overweight at Barclays"), "Barclays");
    assert.equal(parseFirm("Ross Stores initiated outperform at Wolfe Research; PT $279"), "Wolfe Research");
    assert.equal(parseFirm("Jefferies lowered Intel target price to $85 from $120"), "Jefferies");
    assert.equal(parseFirm("Broadcom has plummeted some 33% from its high."), null);
  });
});
