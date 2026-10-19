import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mapFedSpeaker, mapFedSpeakerFromUrl, parseFedSpeechesRss,
} from "./figure-views-ingest.js";

describe("A85 Fed speech ingest helpers", () => {
  it("maps last-name titles to figure ids", () => {
    assert.equal(mapFedSpeaker("Bowman, Supervisory Modernization"), "fed-bowman");
    assert.equal(mapFedSpeaker("Waller, The Signaling Value"), "fed-waller");
    assert.equal(mapFedSpeaker("Powell, Inflation Outlook"), "fed-powell");
    assert.equal(mapFedSpeaker("Jefferson, The U.S. Economy"), null);
  });
  it("maps speech URL slug", () => {
    assert.equal(
      mapFedSpeakerFromUrl("https://www.federalreserve.gov/newsevents/speech/waller20261008a.htm"),
      "fed-waller",
    );
  });
  it("parses RSS items", () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title>Bowman, Test</title><link><![CDATA[https://example.com/bowman]]></link>
      <pubDate><![CDATA[Thu, 15 Oct 2026 02:55:00 GMT]]></pubDate>
      <description><![CDATA[Speech At Somewhere]]></description></item>
    </channel></rss>`;
    const items = parseFedSpeechesRss(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.title, "Bowman, Test");
    assert.ok(items[0]!.link.includes("bowman"));
  });
});
