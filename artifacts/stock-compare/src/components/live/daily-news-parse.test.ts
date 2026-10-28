import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compressImplicationBullet,
  compressMuseBullet,
  parseSections,
  singleNameLead,
  splitImplicationLead,
  splitMuseSoWhat,
  synthesizeSingleNameSoWhats,
} from "./daily-news-parse.ts";

describe("compressMuseBullet", () => {
  it("avgs futures ranges and drops timestamp fluff", () => {
    const raw =
      "Futures are mixed into the day's double event: S&P 500 futures up ~0.1–0.2% near 7,767–7,772, Nasdaq 100 futures up ~0.4–0.45% near 29,920–29,945, Dow futures down ~0.2% near 52,485–52,503. Exact prints vary by timestamp; direction is consistent · tech leading, Dow lagging.";
    const out = compressMuseBullet(raw);
    assert.match(out, /Futures mixed/);
    assert.match(out, /S&P 500 futures ~7,770 \(\+0\.15%\)/);
    assert.match(out, /Technology leads\. Dow lags/);
    assert.doesNotMatch(out, /Exact prints vary/);
    assert.doesNotMatch(out, /7,767/);
  });

  it("avgs oil \$ ranges and strips unverified claim fluff", () => {
    const raw =
      "Oil jumped back: Brent ~$114.84–115.60 (+~1.1–1.6%), WTI ~$101.13–101.75 (+~1.5–2%), after a reported attack on a Saudi refinery revived supply concern. The claim is unconfirmed — the price response is real, the physical disruption is not yet verified.";
    const out = compressMuseBullet(raw);
    assert.match(out, /^Oil:/);
    assert.match(out, /Brent \$115/);
    assert.doesNotMatch(out, /unconfirmed/i);
  });

  it("keeps STOXX 600 index name with signed % (no false level avg)", () => {
    const out = compressMuseBullet(
      "Europe is softer in afternoon trading: STOXX 600 −0.25–0.26%, FTSE 100 −0.30–0.35%, DAX flat to −0.16%.",
    );
    assert.match(out, /STOXX 600 \(-0\.26%\)/);
    assert.match(out, /FTSE 100 \(-0\.32%\)/);
    assert.match(out, /DAX \(-0\.16%\)/);
    assert.doesNotMatch(out, /~300/);
  });

  it("strips Why-it-matters essay leads; keeps FOMC/Warsh levels", () => {
    const out = compressMuseBullet(
      "Today is the main event, not the warm-up: FOMC decision at 2:00 PM ET, Warsh press conference at 2:30 PM ET, and Alphabet plus Microsoft after the close. A hold is ~92–95% priced — the trade is in Warsh's tone on December, where a further hike remains the open question.",
    );
    assert.doesNotMatch(out, /main event|warm-up/i);
    assert.doesNotMatch(out, /PM ET/);
    assert.match(out, /FOMC decision at 2:00 ET/);
    assert.match(out, /Hold ~94% priced/);
    assert.match(out, /Warsh/);
  });

  it("rewrites closes/Asia to level (%change) like futures", () => {
    const tue = compressMuseBullet(
      "Tuesday closed strong: S&P 500 +0.60% to 7,722.60, Nasdaq Composite +1.18% to 26,477.81, Dow essentially flat at 52,377.57 (+0.03%), Russell 2000 +1.16% to 2,818.87. VIX eased to ~17.50–17.52.",
    );
    assert.match(tue, /S&P 500 ~7,723 \(\+0\.60%\)/);
    assert.match(tue, /Nasdaq Composite ~26,478 \(\+1\.18%\)/);
    assert.match(tue, /Dow ~52,378 \(\+0\.03%\)/);
    assert.match(tue, /Russell 2000 ~2,819 \(\+1\.16%\)/);
    assert.match(tue, /VIX ~17\.51/);
    assert.doesNotMatch(tue, /\+0\.60% to/);

    const asia = compressMuseBullet(
      "Asia was the overnight story: KOSPI +6.6% to ~6,012 on SK Hynix's record quarter, Nikkei +1.08% to 63,954, Shanghai +0.91% to 3,681, Hang Seng +0.23%, Taiwan +~2%.",
    );
    assert.match(asia, /KOSPI ~6,012 \(\+6\.6%\)/);
    assert.match(asia, /Nikkei ~63,954 \(\+1\.08%\)/);
    assert.match(asia, /Hang Seng \(\+0\.23%\)/);
    assert.doesNotMatch(asia, /\+6\.6% to/);
  });
});

describe("parseSections", () => {
  it("parses bare **Catalyst** lines (no leading dash) — was empty-box bug", () => {
    const md = `## Overnight / Macro

**Oil weakness extends; WTI down 1.9% to $87.76** — Gulf flow recovery.

**Treasury futures volatility ahead** — Yield regime under pressure.

## Sector & tickers

**GOOGL — Wells Fargo maintain Overweight (2026-10-06).** Book watch.

## Put-seller takeaway

S&P 500 +0.58%, Nasdaq ATH; equity bias elevated into week.`;
    const secs = parseSections(md);
    assert.equal(secs.length, 3);
    assert.equal(secs[0]!.title, "Overnight / Macro");
    assert.equal(secs[0]!.bullets.length, 2);
    assert.match(secs[0]!.bullets[0]!, /WTI/);
    assert.ok(secs.find((s) => s.title === "Put-seller takeaway")?.bullets.length);
  });

  it("parses markdown dash bullets", () => {
    const md = `## Overnight / Macro
- **ES +0.30%** — risk-on into open.
- **10Y ~5.27%** — rates still elevated.`;
    const secs = parseSections(md);
    assert.equal(secs[0]!.bullets.length, 2);
  });

  it("drops empty headings", () => {
    const md = `## Overnight / Macro

## Sector & tickers
- **NFLX earnings 2026-10-20** — IV watch.`;
    const secs = parseSections(md);
    assert.equal(secs.length, 1);
    assert.equal(secs[0]!.title, "Sector & tickers");
  });
});

describe("splitMuseSoWhat + synthesize", () => {
  it("strips So what trailer from fact", () => {
    const { fact, soWhat } = splitMuseSoWhat(
      "VRT +17% premarket: blowout quarter. So what: AI demand is real — don't chase short puts into +17%.",
    );
    assert.match(fact, /^VRT/);
    assert.doesNotMatch(fact, /So what/i);
    assert.match(soWhat!, /AI demand/);
    assert.equal(singleNameLead(fact), "VRT");
  });

  it("labels tonight binaries as GOOGL/MSFT", () => {
    assert.equal(singleNameLead("Tonight's binaries: GOOGL +1.3% premarket"), "GOOGL/MSFT");
  });

  it("compresses so-whats with lead prefix", () => {
    const out = synthesizeSingleNameSoWhats([
      {
        lead: "VRT",
        soWhat: "AI power demand is real — but this is a gap; don't chase short puts into +17%.",
      },
    ]);
    assert.match(out[0]!, /^VRT:/);
    assert.match(out[0]!, /no chase short puts/);
    assert.doesNotMatch(out[0]!, /don't chase/i);
  });
});

describe("compressImplicationBullet", () => {
  it("adds Event walls / VIX leads and shortens RH expiry", () => {
    const walls = compressImplicationBullet(
      "Two event walls today (Fed 2:00 PM ET, GOOGL/MSFT AMC): keep new short premium short-dated and sized for vol expansion if Warsh leans hawkish on December — a hold with a hawkish presser is still a vol event.",
    );
    assert.match(walls, /^Event walls:/);
    assert.match(walls, /hawkish hold still/);
    const lead = splitImplicationLead(walls);
    assert.equal(lead?.lead, "Event walls");
    assert.match(lead!.body, /Fed 2:00/);

    const vix = compressImplicationBullet(
      "VIX ~17.5 is not cheap with a Fed decision and two hyperscaler prints in one session. Favor broad-index premium over single-name earnings premium today; tonight's prints are the exception that proves the rule.",
    );
    assert.match(vix, /^VIX:/);
    assert.match(vix, /Prefer index premium/);
    assert.doesNotMatch(vix, /exception that proves/);

    const exp = compressImplicationBullet(
      "Expiry discipline: Friday Oct 30 is expiry — under Robinhood's rule, ITM shorts can be sold in the last 30 minutes Friday, so the effective deadline to close or roll ITM shorts is Thursday's close, not Friday's expiry. Check the book before Thursday's close.",
    );
    assert.match(exp, /^Expiry discipline:/);
    assert.match(exp, /RH:/);
    assert.match(exp, /Thu close/);
  });

  it("does not split on Fed 2:00 mid-time", () => {
    assert.equal(
      splitImplicationLead("Two event walls today (Fed 2:00 PM ET): keep premium short"),
      null,
    );
  });
});
