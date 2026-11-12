import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rationalApproxInvNorm } from "./legs.js";
import { atmIv } from "./rank.js";
import type { OptionsChainResult } from "../options.js";

// A205 D1/D2 (Codex implementation-delta-check 11-11): Ranker's own invNorm gave 0.0381 at p = 0.95 (truth 1.6449)
// and its ATM IV came from the first listed strike ≤ spot. Ranker now uses the one validated inverse normal.
describe("structures ranker distribution inputs", () => {
  it("inverse normal matches reference quantiles (< 1e-5)", () => {
    for (const [p, ref] of [[0.025, -1.959963984540054], [0.05, -1.6448536269514729], [0.5, 0], [0.95, 1.6448536269514722], [0.975, 1.959963984540054]]) {
      assert.ok(Math.abs(rationalApproxInvNorm(p) - ref) < 1e-5, `p=${p}: ${rationalApproxInvNorm(p)} vs ${ref}`);
    }
  });

  it("ATM IV comes from the strike nearest spot, not the farthest listed", () => {
    const chain = {
      spot: 100, expiry: "2026-12-18", daysToExpiry: 30,
      puts: [{ strike: 60, iv: 0.9 }, { strike: 95, iv: 0.32 }, { strike: 100, iv: 0.3 }],
      calls: [{ strike: 100, iv: 0.28 }, { strike: 105, iv: 0.27 }, { strike: 150, iv: 0.8 }],
    } as unknown as OptionsChainResult;
    assert.ok(Math.abs(atmIv(chain) - 0.29) < 1e-9, String(atmIv(chain)));
  });

  it("ATM IV skips zero/missing IV and falls back to 0.25 only with no chain", () => {
    const chain = { spot: 100, puts: [{ strike: 100, iv: 0 }, { strike: 98, iv: 0.4 }], calls: [] } as unknown as OptionsChainResult;
    assert.equal(atmIv(chain), 0.4);
    assert.equal(atmIv(null), 0.25);
  });
});

import { mergeLadder } from "./ranker-chain.js";
import { buildTemplate } from "./templates.js";
import { payoffAtTime, payoffAtSpot, type Leg, type ChainContext } from "./legs.js";

const day = 86_400_000;
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const lad = (expiry: string, side: "put" | "call", strike: number, px: number) =>
  ({ expiry, side, strike, bid: px - 0.05, ask: px + 0.05, mark: px, iv: 0.4, delta: null, oi: 100, volume: 10 });

describe("A205 ranker chain fill + mixed-expiry valuation", () => {
  const now = Date.now();
  const e5 = ymd(now + 5 * day), e30 = ymd(now + 30 * day), e60 = ymd(now + 60 * day);
  // stored engine chain: 5-DTE only, OTM calls only (the real producer shape)
  const stored = [{ ticker: "X", expiry: e5, isWeekly: true, daysToExpiry: 5, exactDte: 5, settlementDte: 5, spot: 100, tier: 1,
    puts: [{ strike: 95, bid: 0.5, ask: 0.6, iv: 0.4 }], calls: [{ strike: 105, bid: 0.5, ask: 0.6, iv: 0.4 }], fetchedAt: now }] as unknown as OptionsChainResult[];
  const ladder = [e5, e30, e60].flatMap((e) => [95, 100, 105].flatMap((k) => [lad(e, "put", k, 3), lad(e, "call", k, 3)]));

  it("merge adds ATM strikes and 30/60-day expiries; stored rows win", () => {
    const m = mergeLadder(stored, ladder, 100, now);
    assert.deepEqual(m.map((c) => c.expiry), [e5, e30, e60]);
    assert.ok(m[0].calls.some((r) => r.strike === 100));
    assert.equal(m[0].calls.find((r) => r.strike === 105)!.bid, 0.5);   // stored quote kept
  });

  it("straddle is at a strike both sides list; calendar = horizon expiry + ~30 d", () => {
    const m = mergeLadder(stored, ladder, 100, now);
    const st = buildTemplate("long_straddle", { chains: m, horizonDays: 30 })!.legs;
    assert.deepEqual(st.map((l) => [l.kind, l.strike, l.expiry]), [["call", 100, e30], ["put", 100, e30]]);
    const cal = buildTemplate("calendar", { chains: m, horizonDays: 30 })!.legs;
    assert.deepEqual(cal.map((l) => [l.side, l.strike, l.expiry]), [["short", 100, e30], ["long", 100, e60]]);
  });

  it("payoffAtTime = intrinsic for single expiry at expiry; keeps back-leg time value for a calendar", () => {
    const m = mergeLadder(stored, ladder, 100, now);
    const ctx: ChainContext = { spot: 100, chains: m };
    const single: Leg[] = [{ kind: "call", side: "long", qty: 1, strike: 100, expiry: e30 }];
    const t30 = new Date(`${e30}T16:00:00`).getTime();
    assert.ok(Math.abs(payoffAtTime(single, ctx, 110, -300, t30) - payoffAtSpot(single, ctx, 110, -300, true)) < 1e-6);
    const cal: Leg[] = [{ kind: "call", side: "short", qty: 1, strike: 100, expiry: e30 }, { kind: "call", side: "long", qty: 1, strike: 100, expiry: e60 }];
    assert.ok(payoffAtTime(cal, ctx, 100, -150, t30) > 0, "ATM at front expiry: back call worth > net debit");
    assert.ok(payoffAtSpot(cal, ctx, 100, -150, true) <= -150 + 1e-6, "old all-intrinsic view = full loss");
  });
});
