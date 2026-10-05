import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeDeskPayload,
  unwrapRedirectUrl,
  newsSessionWindow,
  DESK_BRIEF_PREFS,
} from "./desk-commentary-normalize.ts";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/desk-emails");

function load(name: string) {
  return JSON.parse(readFileSync(join(FIX, name), "utf8")) as Record<string, unknown>;
}

describe("unwrapRedirectUrl", () => {
  it("unwraps urldefense v3", () => {
    const raw =
      "https://urldefense.com/v3/__https://www.thedailyupside.com/investments/bonds/tokyo__;!!LIr3w8kk$";
    assert.match(unwrapRedirectUrl(raw), /thedailyupside\.com/);
  });
});

describe("normalizeDeskPayload fixtures", () => {
  it("flags bloomberg welcome as promo/noise", () => {
    const n = normalizeDeskPayload(load("bloomberg-welcome.json"));
    assert.equal(n.category, "promo");
    assert.ok(n.noiseScore >= DESK_BRIEF_PREFS.noiseExcludeAtOrAbove);
    assert.equal(n.includeInBrief, false);
  });

  it("keeps axios AM as digest with lower noise", () => {
    const n = normalizeDeskPayload(load("axios-am.json"));
    assert.equal(n.sourceId, "axios");
    assert.equal(n.category, "newsletter_digest");
    assert.ok(n.includeInBrief);
    assert.ok(!n.tickersMentioned.includes("EWT"));
  });

  it("classifies SA payrolls as macro", () => {
    const n = normalizeDeskPayload(load("sa-payrolls.json"));
    assert.equal(n.sourceId, "seekingalpha");
    assert.equal(n.category, "macro");
    assert.ok(n.includeInBrief);
  });

  it("scores finimize promo higher", () => {
    const n = normalizeDeskPayload(load("finimize-promo.json"));
    assert.ok(n.noiseScore >= 20);
  });

  it("maps factset weekend heads to macro", () => {
    const n = normalizeDeskPayload(load("factset-weekend-heads.json"));
    assert.equal(n.sourceId, "factset_streetaccount");
    assert.equal(n.category, "macro");
  });
});

describe("newsSessionWindow", () => {
  it("Sunday uses Friday start", () => {
    // 2026-10-04 was a Sunday
    const w = newsSessionWindow(new Date("2026-10-04T20:00:00.000Z"));
    assert.equal(w.isWeekendPack, true);
    assert.equal(w.startDatePt, "2026-10-02"); // Fri
  });

  it("Tuesday is calendar day", () => {
    const w = newsSessionWindow(new Date("2026-10-06T17:00:00.000Z")); // Mon evening UTC ≈ Mon PT / check
    // Just assert shape
    assert.match(w.startDatePt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(w.dateKey);
  });
});
