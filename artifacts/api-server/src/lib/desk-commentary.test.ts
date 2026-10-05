import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyKind,
  extractSynopsis,
  extractTickers,
  gmailIdFromFileName,
  parseEml,
} from "./desk-commentary-parse.ts";

describe("classifyKind", () => {
  it("maps overnight / recap / oil / politics / sectors", () => {
    assert.equal(classifyKind("SA: StreetAccount Summary - U.S. Overnight: 1-Oct"), "us_overnight");
    assert.equal(classifyKind("SA: StreetAccount Summary - U.S. Market Recap: 1-Oct"), "us_market_recap");
    assert.equal(classifyKind("SA: StreetAccount Macro Update: Oil"), "macro_oil");
    assert.equal(classifyKind("SA: StreetAccount Summary - Politics of the Market: 1-Oct"), "politics");
    assert.equal(classifyKind("SA: StreetAccount Sector Summary - Technology"), "sector_technology");
    assert.equal(classifyKind("SA: StreetAccount Sector Summary - Energy"), "sector_energy");
    assert.equal(classifyKind("SA: StreetAccount Sector Summary - Consumer"), "sector_consumer");
  });
});

describe("extractors", () => {
  it("pulls synopsis and tickers", () => {
    const plain = "Synopsis: Equities mixed overnight amid oil strength.\nNotable stories include:\nAAPL (Apple) -- gains\nSubjects:";
    assert.match(extractSynopsis(plain), /Equities mixed/);
    const tickers = extractTickers("AAPL (Apple) -- NVDA (Nvidia) /");
    assert.ok(tickers.includes("AAPL"));
    assert.ok(tickers.includes("NVDA"));
  });

  it("reads gmail id from multi-source filename", () => {
    assert.equal(
      gmailIdFromFileName("2026-09-25_0601-factset-1a0d8a88bc6b121e-SA-StreetAccount.eml"),
      "1a0d8a88bc6b121e",
    );
    assert.equal(
      gmailIdFromFileName("2026-10-02_0509-seekingalpha-abcdef1234567890-Market-News.eml"),
      "abcdef1234567890",
    );
    assert.equal(
      gmailIdFromFileName("2026-10-02_0859-usc-factset-1a0fd57ac0b4d23f-SA-Week-Ahead.json"),
      "1a0fd57ac0b4d23f",
    );
    assert.equal(
      gmailIdFromFileName("2026-10-02_0900-personal-desk-abcdef1234567890-Morning-Brief.json"),
      "abcdef1234567890",
    );
  });
});

describe("parseEml", () => {
  it("parses a minimal multipart text/plain message", () => {
    const raw = [
      "From: FactSet Alerts <FactSet_Alerts@factset.com>",
      "Subject: SA: StreetAccount Summary - U.S. Overnight: 1-Oct",
      "Date: Wed, 1 Oct 2026 11:35:00 +0000",
      "Message-ID: <abc@email.amazonses.com>",
      'Content-Type: multipart/alternative; boundary="bnd"',
      "",
      "--bnd",
      "Content-Type: text/plain; charset=UTF-8",
      "",
      "Synopsis: Futures firm; VIX quiet.",
      "Notable: AAPL (Apple) -- bid",
      "--bnd--",
      "",
    ].join("\r\n");
    const parsed = parseEml(raw, "2026-10-01_0435-factset-deadbeef01-SA-Overnight.eml");
    assert.equal(parsed.kind, "us_overnight");
    assert.equal(parsed.gmailMessageId, "deadbeef01");
    assert.match(parsed.synopsis, /Futures firm/);
    assert.ok(parsed.tickersMentioned.includes("AAPL"));
  });
});
