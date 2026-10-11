import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isTradingDayYmd, lastCompletedSessionYmd } from "./market-hours.ts";
import { schwabCandleYmd } from "./schwab-client.ts";
import { mergeSchwabYahoo } from "./indicators.ts";

describe("lastCompletedSessionYmd", () => {
  it("rolls weekends, pre-close and holidays back to the last session", () => {
    assert.equal(lastCompletedSessionYmd(new Date("2026-10-11T19:00:00Z")), "2026-10-09"); // Sun → Fri
    assert.equal(lastCompletedSessionYmd(new Date("2026-10-12T14:00:00Z")), "2026-10-09"); // Mon 10:00 ET → Fri
    assert.equal(lastCompletedSessionYmd(new Date("2026-10-12T20:30:00Z")), "2026-10-12"); // Mon 16:30 ET → Mon
    assert.equal(lastCompletedSessionYmd(new Date("2026-10-10T05:45:00Z")), "2026-10-09"); // Fri 22:45 PT (Sat 01:45 ET)
    assert.equal(lastCompletedSessionYmd(new Date("2026-11-26T22:00:00Z")), "2026-11-25"); // Thanksgiving
    assert.equal(isTradingDayYmd("2026-11-26"), false);
    assert.equal(isTradingDayYmd("2026-10-12"), true);
  });
});

describe("Schwab daily bars", () => {
  it("dates candles stamped at midnight CT on the ET trading day", () => {
    assert.equal(schwabCandleYmd(Date.parse("2026-10-09T05:00:00Z")), "2026-10-09");
  });
  it("prefers Schwab on conflict and fills gaps from Yahoo", () => {
    const bar = (d: string, close: number) => ({ date: new Date(`${d}T16:00:00Z`), open: close, high: close, low: close, close, volume: 1 });
    const m = mergeSchwabYahoo([bar("2026-10-08", 10), bar("2026-10-09", 11)], [bar("2026-10-07", 9), bar("2026-10-08", 99)]);
    assert.deepEqual(m.map((b) => [b.date.toISOString().slice(0, 10), b.close, b.source]), [
      ["2026-10-07", 9, "yahoo"], ["2026-10-08", 10, "schwab"], ["2026-10-09", 11, "schwab"],
    ]);
  });
});
