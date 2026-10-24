/**
 * A267 success check (pure). Live pass is the refresh script + this file:
 * each feed has Model List rows; polygon gate; Schwab api_usage; expirationchain
 * log; movers on Live; ship-check + these tests green.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { isMarketOpen, setSchwabMarketDay } from "./market-hours.js";
import {
  expiryWindowFromChain,
  feedDue,
  isHardEvent,
  map8k,
  mapForm4,
  mapMovers,
  mapRelated,
  netBuys90d,
  parseExpirationChain,
  parseSchwabHours,
  weeklyFromListing,
  ymdAdd,
} from "./unused-feeds-parse.js";

after(() => setSchwabMarketDay(null));

describe("A267 feeds", () => {
  const today = "2026-10-24";

  it("maps Form 4 P/S to buy/sell and nets 90d value", () => {
    const want = new Set(["AAPL"]);
    const { rows, leak } = mapForm4([
      {
        tickers: ["AAPL"],
        filing_date: "2026-10-01",
        transaction_date: "2026-09-29",
        transaction_code: "P",
        owner_name: "Cook",
        officer_title: "CEO",
        owner_cik: "1",
        accession_number: "acc-1",
        security_title: "Common",
        transaction_shares: 100,
        transaction_price_per_share: 10,
        transaction_value: 1000,
        record_type: "transaction",
      },
      {
        tickers: ["AAPL"],
        filing_date: "2026-10-02",
        transaction_date: "2026-10-01",
        transaction_code: "S",
        owner_name: "Cook",
        owner_cik: "1",
        accession_number: "acc-2",
        security_title: "Common",
        transaction_shares: 40,
        transaction_value: 500,
        record_type: "transaction",
      },
      {
        tickers: ["AAPL"],
        filing_date: "2026-10-03",
        transaction_code: "A",
        owner_name: "Cook",
        owner_cik: "1",
        accession_number: "acc-3",
        security_title: "RSU",
        transaction_value: 9000,
        record_type: "transaction",
      },
    ], want);
    assert.equal(leak, false);
    assert.deepEqual(rows.map((r) => r.code), ["buy", "sell", "other"]);
    assert.equal(rows[0]?.role, "CEO");
    const net = netBuys90d(rows, today);
    assert.equal(net.netValue, 500);
    assert.equal(net.buys, 1);
    assert.equal(net.sells, 1);
  });

  it("stops on a Form 4 filter leak", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      tickers: [i === 0 ? "AAPL" : "ZZZZ"],
      filing_date: "2026-10-01",
      transaction_code: "P",
      accession_number: `a${i}`,
      record_type: "transaction",
    }));
    const mapped = mapForm4(rows, new Set(["AAPL"]));
    assert.equal(mapped.leak, true);
    assert.equal(mapped.rows.length, 0);
  });

  it("maps 8-K category and skips earnings as a hard event", () => {
    const { rows, leak } = map8k([
      {
        tickers: ["MSFT"],
        filing_date: "2026-10-10",
        accession_number: "8k-1",
        primary_category: "leadership",
        tertiary_category: "officer_change",
      },
    ], new Set(["MSFT"]));
    assert.equal(leak, false);
    assert.equal(rows[0]?.category, "officer_change");
    assert.equal(isHardEvent(rows[0]?.category ?? null, rows[0]?.primaryCategory ?? null), true);
    assert.equal(isHardEvent("quarterly_results", "financial_results"), false);
  });

  it("maps related tickers and movers", () => {
    assert.deepEqual(mapRelated({ results: [{ ticker: "msft" }, { ticker: "MSFT" }, { ticker: "nvda" }] }), ["MSFT", "NVDA"]);
    const movers = mapMovers({
      screeners: [{ symbol: "aapl", netPercentChange: 2.5, totalVolume: 1_200_000, lastPrice: 220 }],
    });
    assert.equal(movers[0]?.symbol, "AAPL");
    assert.equal(movers[0]?.percent, 2.5);
    assert.equal(movers[0]?.volume, 1_200_000);
  });

  it("expiry window is the listed band, not today+45", () => {
    const listed = parseExpirationChain({
      expirationList: [
        { expirationDate: "2026-10-30", expirationType: "W", standard: false },
        { expirationDate: "2026-11-20", expirationType: "S", standard: true },
        { expirationDate: "2026-12-18", expirationType: "S", standard: true },
      ],
    });
    const window = expiryWindowFromChain(listed.map((e) => e.expiry), today, 45);
    assert.deepEqual(window, { from: "2026-10-30", to: "2026-11-20" });
    assert.notEqual(window?.to, ymdAdd(today, 45));
    assert.equal(expiryWindowFromChain([], today, 45), null);
  });

  it("empty vendor results back off for 7 days", () => {
    assert.equal(feedDue("2026-10-23", 0, today, 1, 7), false);
    assert.equal(feedDue("2026-10-17", 0, today, 1, 7), true);
    assert.equal(feedDue("2026-10-23", 4, today, 1, 7), true);
    assert.equal(feedDue(today, 4, today, 1, 7), false);
    assert.equal(feedDue(null, 0, today, 1, 7), true);
  });

  it("Schwab closed session overrides a normal weekday calendar", () => {
    const now = new Date("2026-10-21T19:00:00Z"); // Wed 15:00 ET
    setSchwabMarketDay(null);
    assert.equal(isMarketOpen(now), true);
    setSchwabMarketDay({ date: "2026-10-21", isOpen: false, openMin: 570, closeMin: 960 });
    assert.equal(isMarketOpen(now), false);
    setSchwabMarketDay({ date: "2026-10-21", isOpen: true, openMin: 570, closeMin: 12 * 60 });
    assert.equal(isMarketOpen(now), false);
    setSchwabMarketDay(null);
  });

  it("treats Schwab type W as weekly even when standard is true", () => {
    assert.equal(weeklyFromListing("W", true, false), true);
    assert.equal(weeklyFromListing("S", true, true), false);
  });

  it("parses Schwab equity hours", () => {
    const day = parseSchwabHours({
      equity: {
        EQ: {
          date: "2026-10-24",
          isOpen: true,
          sessionHours: {
            regularMarket: [{ start: "2026-10-24T09:30:00-04:00", end: "2026-10-24T16:00:00-04:00" }],
          },
        },
      },
    }, today);
    assert.equal(day?.isOpen, true);
    assert.equal(day?.openMin, 570);
    assert.equal(day?.closeMin, 960);
  });
});
