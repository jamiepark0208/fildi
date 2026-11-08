import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  putCallParityError,
  priceStructure,
  payoffAtSpot,
  bsOptionPrice,
  type ChainContext,
  type Leg,
  OPTION_MULT,
  priceLegs,
  DEFAULT_RISK_FREE,
  pickExpiry,
} from "./legs.js";
import { bsGreeks } from "../options-greeks.js";
import { buildTemplate, type TemplateId } from "./templates.js";

function tplLegs(id: TemplateId, opts: Parameters<typeof buildTemplate>[1]): Leg[] | null {
  return buildTemplate(id, opts)?.legs ?? null;
}
import type { OptionsChainResult } from "../options.js";

const SYNTH_IV = 0.25;

function synthChain(
  spot: number,
  expiry: string,
  dte: number,
  strikeLo = spot - 30,
  strikeHi = spot + 30,
  step = 5,
): OptionsChainResult {
  const T = dte / 365;
  const strikes: number[] = [];
  for (let k = strikeLo; k <= strikeHi; k += step) strikes.push(k);
  const quote = (K: number, isCall: boolean) => {
    const mid = bsOptionPrice(isCall ? "call" : "put", spot, K, T, DEFAULT_RISK_FREE, SYNTH_IV);
    const spread = Math.max(mid * 0.04, 0.02);
    const bid = Math.max(mid - spread / 2, 0.01);
    const ask = bid + spread;
    const { delta } = bsGreeks(spot, K, T, DEFAULT_RISK_FREE, SYNTH_IV, isCall);
    return {
      strike: K,
      bid,
      ask,
      lastPrice: mid,
      iv: SYNTH_IV,
      volume: 10,
      openInterest: 100,
      incomePct: 0,
      meetsGate: true,
      bidIsLive: true,
      quoteStale: false,
      delta,
      spreadPct: spread / Math.max(mid, 0.01),
    };
  };
  return {
    ticker: "TEST",
    expiry,
    isWeekly: false,
    daysToExpiry: dte,
    exactDte: dte,
    settlementDte: dte,
    spot,
    tier: 1,
    puts: strikes.map((K) => quote(K, false)),
    calls: strikes.map((K) => quote(K, true)),
    fetchedAt: Date.now(),
  };
}

/** 31 guide strategies — same template ids as strategy-guide.ts */
const GUIDE_TEMPLATE_IDS: TemplateId[] = [
  "covered_call", "debit_call_vertical", "call_zebra", "pmcc", "calendar", "call_butterfly",
  "big_lizard", "covered_put", "debit_put_vertical", "put_zebra", "put_diagonal", "put_calendar",
  "put_butterfly", "reverse_big_lizard", "put_front_ratio", "call_front_ratio",
  "put_broken_wing_butterfly", "call_broken_wing_butterfly", "call_broken_heart", "put_broken_heart",
  "short_strangle", "short_straddle", "iron_condor", "dynamic_iron_condor", "iron_fly",
  "cash_secured_put", "bull_put_spread", "jade_lizard", "short_naked_call", "bear_call_spread",
  "reverse_jade_lizard",
];

const BULLISH_DELTAS = new Set<TemplateId>([
  "covered_call", "debit_call_vertical", "call_zebra", "pmcc",
  "big_lizard", "jade_lizard", "bull_put_spread", "cash_secured_put",
]);
const BEARISH_DELTAS = new Set<TemplateId>([
  "covered_put", "debit_put_vertical", "put_zebra", "put_diagonal",
  "reverse_big_lizard", "bear_call_spread", "reverse_jade_lizard", "short_naked_call",
]);

describe("legs — put-call parity", () => {
  it("|C−P−(S−K·e^{-rT})| < 0.01", () => {
    const err = putCallParityError(100, 100, 0.5, 0.05, 0.25);
    assert.ok(Math.abs(err) < 0.01, `parity err=${err}`);
  });
});

describe("legs — CSP max loss", () => {
  it("max loss = 100·K − credit", () => {
    const chain = synthChain(100, "2026-12-19", 40);
    const K = 95;
    const legs: Leg[] = [{ kind: "put", side: "short", qty: 1, strike: K, expiry: chain.expiry }];
    const ctx: ChainContext = { spot: 100, chains: [chain] };
    const priced = priceStructure(legs, ctx, 40);
    const expected = K * OPTION_MULT - priced.netFill;
    assert.ok(Math.abs(priced.maxLoss - expected) < 1, `maxLoss=${priced.maxLoss} expected=${expected}`);
  });
});

describe("legs — naked short call", () => {
  it("max loss is unbounded", () => {
    const chain = synthChain(100, "2026-12-19", 30);
    const legs: Leg[] = [{ kind: "call", side: "short", qty: 1, strike: 100, expiry: chain.expiry }];
    const ctx: ChainContext = { spot: 100, chains: [chain] };
    const priced = priceStructure(legs, ctx, 30);
    assert.ok(priced.maxLoss >= 1e14, `maxLoss=${priced.maxLoss}`);
  });
});

describe("legs — POP", () => {
  it("ATM short straddle POP < 50% (tight flat quote slice)", () => {
    const spot = 100;
    const K = 100;
    const chain: OptionsChainResult = {
      ...synthChain(spot, "2026-12-19", 30, K - 10, K + 10, 5),
      calls: [{ strike: K, bid: 2, ask: 2.4, lastPrice: 2.2, iv: 0.25, volume: 10, openInterest: 100, incomePct: 0, meetsGate: true, bidIsLive: true, quoteStale: false, delta: 0.5, spreadPct: 0.18 }],
      puts: [{ strike: K, bid: 2, ask: 2.4, lastPrice: 2.2, iv: 0.25, volume: 10, openInterest: 100, incomePct: 0, meetsGate: true, bidIsLive: true, quoteStale: false, delta: -0.5, spreadPct: 0.18 }],
    };
    const legs: Leg[] = [
      { kind: "call", side: "short", qty: 1, strike: K, expiry: chain.expiry },
      { kind: "put", side: "short", qty: 1, strike: K, expiry: chain.expiry },
    ];
    const ctx: ChainContext = { spot, chains: [chain], riskFree: DEFAULT_RISK_FREE };
    const priced = priceStructure(legs, ctx, 30);
    assert.ok(priced.pop < 0.5, `short straddle POP=${priced.pop}`);
  });

  it("deep OTM short put POP > 85% (10% OTM, 45 DTE, IV 25%)", () => {
    const spot = 100;
    const chain = synthChain(spot, "2026-12-19", 45);
    const legs: Leg[] = [{ kind: "put", side: "short", qty: 1, strike: 90, expiry: chain.expiry }];
    const ctx: ChainContext = { spot, chains: [chain], riskFree: DEFAULT_RISK_FREE };
    const priced = priceStructure(legs, ctx, 45);
    assert.ok(priced.pop > 0.85, `deep OTM CSP POP=${priced.pop}`);
  });

  it("OTM short put POP higher at 4 DTE than 30 DTE (T = leg expiry)", () => {
    const spot = 100;
    const strike = 98;
    const extraStrikes = [spot - 10, spot - 5, strike, spot, spot + 5, spot + 10];
    const row = (K: number) => ({
      strike: K,
      bid: 1.5,
      ask: 1.9,
      lastPrice: 1.7,
      iv: 0.28,
      volume: 10,
      delta: -0.25,
      openInterest: 100,
      incomePct: 0,
      meetsGate: true,
      bidIsLive: true,
      quoteStale: false,
      spreadPct: 0.2,
    });
    const chain4: OptionsChainResult = {
      ...synthChain(spot, "2026-11-11", 4),
      puts: extraStrikes.map((K) => row(K)),
      calls: extraStrikes.map((K) => ({ ...row(K), delta: 0.25 })),
    };
    const chain30: OptionsChainResult = {
      ...synthChain(spot, "2026-12-19", 30),
      puts: extraStrikes.map((K) => row(K)),
      calls: extraStrikes.map((K) => ({ ...row(K), delta: 0.25 })),
    };
    const legs4: Leg[] = [{ kind: "put", side: "short", qty: 1, strike, expiry: chain4.expiry }];
    const legs30: Leg[] = [{ kind: "put", side: "short", qty: 1, strike, expiry: chain30.expiry }];
    const ctx4: ChainContext = { spot, chains: [chain4], riskFree: DEFAULT_RISK_FREE };
    const ctx30: ChainContext = { spot, chains: [chain30], riskFree: DEFAULT_RISK_FREE };
    const pop4 = priceStructure(legs4, ctx4, 30).pop;
    const pop30 = priceStructure(legs30, ctx30, 30).pop;
    assert.ok(pop4 > pop30, `4 DTE POP=${pop4} vs 30 DTE POP=${pop30}`);
  });
});

describe("pickExpiry — horizon", () => {
  it("DTE ≥ horizon − 7 and nearest target", () => {
    const chains = [
      synthChain(100, "2026-11-11", 4),
      synthChain(100, "2026-11-21", 14),
      synthChain(100, "2026-12-19", 42),
      synthChain(100, "2027-01-16", 70),
    ];
    const picked = pickExpiry(chains, 30);
    assert.ok(picked, "picked");
    assert.ok(picked!.daysToExpiry >= 23, `DTE=${picked!.daysToExpiry}`);
    assert.ok(Math.abs(picked!.daysToExpiry - 30) <= Math.abs(42 - 30), "nearest among eligible");
  });
});

describe("legs — CSP", () => {
  it("payoff matches short put", () => {
    const chain = synthChain(100, "2026-12-19", 40);
    const legs: Leg[] = [{ kind: "put", side: "short", qty: 1, strike: 95, expiry: chain.expiry }];
    const ctx: ChainContext = { spot: 100, chains: [chain] };
    const { netFill } = priceLegs(legs, ctx);
    assert.ok(netFill > 0, "credit");
    const at90 = payoffAtSpot(legs, ctx, 90, netFill, true);
    const at100 = payoffAtSpot(legs, ctx, 100, netFill, true);
    assert.ok(at90 < at100, "deeper ITM hurts short put");
    assert.ok(Math.abs(at100 - netFill) < 1, "OTM ≈ keep credit");
  });
});

describe("legs — iron condor max loss", () => {
  it("max loss ≈ width − credit", () => {
    const spot = 100;
    const chain = synthChain(spot, "2026-12-19", 30);
    const width = 5;
    const legs: Leg[] = [
      { kind: "put", side: "short", qty: 1, strike: 95, expiry: chain.expiry },
      { kind: "put", side: "long", qty: 1, strike: 90, expiry: chain.expiry },
      { kind: "call", side: "short", qty: 1, strike: 105, expiry: chain.expiry },
      { kind: "call", side: "long", qty: 1, strike: 110, expiry: chain.expiry },
    ];
    const ctx: ChainContext = { spot, chains: [chain] };
    const priced = priceStructure(legs, ctx);
    const credit = priced.netFill;
    const expectedMax = width * OPTION_MULT - credit;
    assert.ok(Math.abs(priced.maxLoss - expectedMax) < width * OPTION_MULT * 0.15 + 50,
      `maxLoss=${priced.maxLoss} vs ${expectedMax}`);
  });

  it("buying power = wider wing × 100 − credit (not full strike range)", () => {
    const spot = 100;
    const chain = synthChain(spot, "2026-12-19", 30);
    const legs: Leg[] = [
      { kind: "put", side: "short", qty: 1, strike: 95, expiry: chain.expiry },
      { kind: "put", side: "long", qty: 1, strike: 85, expiry: chain.expiry },
      { kind: "call", side: "short", qty: 1, strike: 105, expiry: chain.expiry },
      { kind: "call", side: "long", qty: 1, strike: 110, expiry: chain.expiry },
    ];
    const priced = priceStructure(legs, { spot, chains: [chain] });
    const expected = 10 * OPTION_MULT - priced.netFill;
    assert.ok(Math.abs(priced.buyingPower - expected) < 1, `bp=${priced.buyingPower} vs ${expected}`);
  });
});

describe("legs — calendar at front expiry", () => {
  it("value vs hand calc", () => {
    const spot = 100;
    const front = synthChain(spot, "2026-01-16", 7);
    const back = synthChain(spot, "2026-02-20", 35);
    const K = 100;
    const legs: Leg[] = [
      { kind: "call", side: "short", qty: 1, strike: K, expiry: front.expiry },
      { kind: "call", side: "long", qty: 1, strike: K, expiry: back.expiry },
    ];
    const ctx: ChainContext = { spot, chains: [front, back], riskFree: DEFAULT_RISK_FREE };
    const { netFill } = priceLegs(legs, ctx);
    const shortRow = front.calls.find((c) => c.strike === K)!;
    const longRow = back.calls.find((c) => c.strike === K)!;
    const shortFill = shortRow.bid + 0.23 * (shortRow.ask - shortRow.bid);
    const longFill = longRow.ask - 0.23 * (longRow.ask - longRow.bid);
    const handCredit = (shortFill - longFill) * OPTION_MULT;
    assert.ok(Math.abs(netFill - handCredit) < 0.02, `fill=${netFill} hand≈${handCredit}`);
  });
});

describe("legs — AAPL stored chain samples", () => {
  it("prices 3 sample trades", async () => {
    if (!process.env.DATABASE_URL) {
      const chain = synthChain(225, "2026-12-19", 30);
      const ctx: ChainContext = { spot: chain.spot, chains: [chain] };
      const legs = tplLegs("cash_secured_put", { chains: [chain], horizonDays: 30 });
      assert.ok(legs);
      const p = priceStructure(legs!, ctx, 30);
      console.log(`SANITY (no DB): synthetic CSP maxLoss=${p.maxLoss.toFixed(2)} POP=${(p.pop * 100).toFixed(1)}%`);
      return;
    }
    const { readChainSnapshot } = await import("../options-chain-store.js");
    const snap = await readChainSnapshot("AAPL").catch(() => null);
    if (!snap?.chains?.length) {
      console.log("SANITY: AAPL chain missing — skip live sample");
      return;
    }
    const ctx: ChainContext = { spot: snap.chains[0].spot, chains: snap.chains };
    const samples: { name: string; legs: Leg[] | null }[] = [
      { name: "CSP", legs: tplLegs("cash_secured_put", { chains: snap.chains, horizonDays: 30 }) },
      { name: "Iron condor", legs: tplLegs("iron_condor", { chains: snap.chains, horizonDays: 30 }) },
      { name: "Covered call", legs: tplLegs("covered_call", { chains: snap.chains, horizonDays: 30 }) },
    ];
    for (const s of samples) {
      if (!s.legs) {
        console.log(`SANITY: ${s.name} — no legs`);
        continue;
      }
      const p = priceStructure(s.legs, ctx, 30);
      console.log(
        `AAPL ${s.name}: netFill=${p.netFill.toFixed(2)} maxLoss=${p.maxLoss.toFixed(2)} POP=${(p.pop * 100).toFixed(1)}% BE=${p.breakevens.map((x) => x.toFixed(2)).join(",")} legs=${JSON.stringify(s.legs)}`,
      );
    }
    assert.ok(samples.some((s) => s.legs), "at least one template built");
  });
});

describe("ranker — horizon DTE", () => {
  it("AAPL neutral rank returns rows under $1000 max loss", async () => {
    if (!process.env.DATABASE_URL) return;
    const { readChainSnapshot } = await import("../options-chain-store.js");
    const { rankStructuresForView } = await import("./rank.js");
    const snap = await readChainSnapshot("AAPL").catch(() => null);
    if (!snap?.chains?.length) {
      console.log("SANITY: AAPL chain missing — skip rank");
      return;
    }
    const r = await rankStructuresForView({
      ticker: "AAPL",
      chains: snap.chains,
      view: "neutral",
      horizonDays: 30,
      maxLoss: 1000,
    });
    console.log(
      `SANITY rank: rows=${r.rows.length} note=${r.expiryNote ?? "—"} coverage=${r.chainCoverage.length}`,
    );
    assert.ok(r.rows.length > 0, `rows=${r.rows.length}`);
  });

  it("template legs use expiry with DTE ≥ horizon − 7", () => {
    const chains = [
      synthChain(225, "2026-11-11", 4),
      synthChain(225, "2026-11-21", 14),
      synthChain(225, "2026-12-19", 42),
    ];
    const minDte = 23;
    const horizonChains = chains.filter((c) => c.daysToExpiry >= minDte);
    const legs = tplLegs("iron_condor", { chains: horizonChains, horizonDays: 30 });
    assert.ok(legs?.length, "legs");
    const exp = legs!.find((l) => l.expiry)?.expiry;
    const chain = chains.find((c) => c.expiry === exp);
    assert.ok(chain && chain.daysToExpiry >= minDte, `template DTE=${chain?.daysToExpiry}`);
    const picked = pickExpiry(horizonChains, 30);
    assert.ok(picked && picked.daysToExpiry >= minDte);
  });
});

describe("Part C — template spot-check on $100 synth", () => {
  const spot = 100;
  const chain45 = synthChain(spot, "2026-12-19", 45);
  const chain75 = synthChain(spot, "2027-01-16", 75);
  const twoExp = [chain45, chain75];

  const spotIds = [
    "iron_condor",
    "jade_lizard",
    "calendar",
    "put_broken_wing_butterfly",
    "put_front_ratio",
  ] as const;

  for (const tid of spotIds) {
    it(`${tid}: priceStructure maxLoss/BE self-consistent`, () => {
      const chains = tid === "calendar" ? twoExp : [chain45];
      const legs = tplLegs(tid, { chains, horizonDays: 45, width: 5 });
      assert.ok(legs?.length, "legs");
      const ctx: ChainContext = { spot, chains };
      const p = priceStructure(legs!, ctx, 45);
      const p2 = priceStructure(legs!, ctx, 45);
      assert.equal(p.maxLoss, p2.maxLoss);
      assert.equal(p.breakevens.length, p2.breakevens.length);
      assert.ok(Number.isFinite(p.maxLoss) && p.maxLoss > 0, `maxLoss=${p.maxLoss}`);
    });
  }

  it("SANITY: IC, jade lizard, call calendar card numbers", () => {
    const rows: { name: string; legs: Leg[] | null }[] = [
      { name: "iron_condor", legs: tplLegs("iron_condor", { chains: [chain45], horizonDays: 45 }) },
      { name: "jade_lizard", legs: tplLegs("jade_lizard", { chains: [chain45], horizonDays: 45 }) },
      { name: "calendar", legs: tplLegs("calendar", { chains: twoExp, horizonDays: 45 }) },
    ];
    const ctx: ChainContext = { spot, chains: twoExp };
    for (const r of rows) {
      assert.ok(r.legs, r.name);
      const p = priceStructure(r.legs!, ctx, 45);
      if (r.name === "iron_condor") assert.ok(p.netFill > 0, `IC must be credit, fill=${p.netFill}`);
      console.log(
        `SANITY card ${r.name}: fill=${p.netFill.toFixed(2)} maxLoss=${p.maxLoss.toFixed(2)} BE=${p.breakevens.map((x) => x.toFixed(2)).join("/")}`,
      );
    }
  });
});

describe("Part C fix1 — 31 guide templates on BS synth chain", () => {
  const spot = 100;
  const chain45 = synthChain(spot, "2026-12-19", 45);
  const chain75 = synthChain(spot, "2027-01-16", 75);
  const chain120 = synthChain(spot, "2027-02-18", 120);
  const twoExp = [chain45, chain75];
  const pmccChains = [chain45, chain120];
  const ctxSingle: ChainContext = { spot, chains: [chain45] };
  const ctxTwo: ChainContext = { spot, chains: twoExp };
  const ctxPmcc: ChainContext = { spot, chains: pmccChains };

  function chainsFor(tid: TemplateId): OptionsChainResult[] {
    if (tid === "calendar" || tid === "put_calendar") return twoExp;
    if (tid === "pmcc" || tid === "put_diagonal") return pmccChains;
    return [chain45];
  }

  it("iron condor is a credit on realistic marks", () => {
    const legs = tplLegs("iron_condor", { chains: [chain45], horizonDays: 45, width: 5 });
    assert.ok(legs);
    const p = priceStructure(legs!, ctxSingle, 45);
    assert.ok(p.netFill > 0, `IC fill=${p.netFill}`);
  });

  it("put front-ratio: best payoff near short strike, worst far below", () => {
    const legs = tplLegs("put_front_ratio", { chains: [chain45], horizonDays: 45, width: 5 });
    assert.ok(legs);
    const p = priceStructure(legs!, ctxSingle, 45);
    const shortK = legs!.find((l) => l.side === "short")!.strike!;
    const sig1 = spot * SYNTH_IV * Math.sqrt(45 / 365);
    const pAtShort = payoffAtSpot(legs!, ctxSingle, shortK, p.netFill);
    const pDeep = payoffAtSpot(legs!, ctxSingle, spot - 3 * sig1, p.netFill);
    assert.ok(pAtShort > pDeep, `short=${pAtShort} deep=${pDeep}`);
  });

  it("call_zebra net delta ≈ +100 shares", () => {
    const legs = tplLegs("call_zebra", { chains: [chain45], horizonDays: 45 });
    assert.ok(legs);
    const p = priceStructure(legs!, ctxSingle, 45);
    assert.ok(p.greeks.delta > 70, `zebra Δ=${p.greeks.delta}`);
  });

  for (const tid of GUIDE_TEMPLATE_IDS) {
    it(`${tid}: priced shape (credit/debit, Δ, max loss, BEs)`, () => {
      const chains = chainsFor(tid);
      const ctx: ChainContext = { spot, chains };
      const legs = tplLegs(tid, { chains, horizonDays: 45, width: 5 });
      assert.ok(legs?.length, `build ${tid}`);
      const p = priceStructure(legs!, ctx, 45);
      assert.ok(Number.isFinite(p.maxLoss) && p.maxLoss > 0, `maxLoss=${p.maxLoss}`);
      const cd = p.netFill >= 0 ? "credit" : "debit";
      console.log(
        `TEMPLATE ${tid}: ${cd} fill=${p.netFill.toFixed(2)} Δ=${p.greeks.delta.toFixed(1)} maxLoss=${p.maxLoss.toFixed(2)} BE=${p.breakevens.map((x) => x.toFixed(2)).join("/") || "—"}`,
      );
      if (BULLISH_DELTAS.has(tid)) assert.ok(p.greeks.delta > 5, `${tid} Δ=${p.greeks.delta}`);
      if (BEARISH_DELTAS.has(tid)) assert.ok(p.greeks.delta < -5, `${tid} Δ=${p.greeks.delta}`);
      const sig1 = spot * SYNTH_IV * Math.sqrt(45 / 365);
      const pUp = payoffAtSpot(legs!, ctx, spot + sig1, p.netFill);
      const pDn = payoffAtSpot(legs!, ctx, spot - sig1, p.netFill);
      if (tid === "iron_condor" || tid === "short_strangle" || tid === "iron_fly") {
        assert.ok(pUp < p.netFill || pDn < p.netFill, `${tid} wings should trail center credit`);
      }
    });
  }
});

const CREDIT_BY_DESIGN: TemplateId[] = [
  "put_front_ratio",
  "call_front_ratio",
  "put_broken_wing_butterfly",
  "call_broken_wing_butterfly",
  "put_broken_heart",
  "call_broken_heart",
  "jade_lizard",
  "reverse_jade_lizard",
];

describe("Part C fix2 — credit-by-design templates on BS synth", () => {
  const spot = 100;
  const chain45 = synthChain(spot, "2026-12-19", 45);
  const ctx: ChainContext = { spot, chains: [chain45] };

  for (const tid of CREDIT_BY_DESIGN) {
    it(`${tid}: net credit on synth (no noCredit flag)`, () => {
      const built = buildTemplate(tid, { chains: [chain45], horizonDays: 45, width: 5 });
      assert.ok(built?.legs.length, "legs");
      assert.ok(!built!.noCredit, `noCredit set for ${tid}`);
      const p = priceStructure(built!.legs, ctx, 45);
      assert.ok(p.netFill > 0, `${tid} fill=${p.netFill}`);
      if (tid === "jade_lizard" || tid === "reverse_jade_lizard") {
        const wingPts =
          tid === "jade_lizard"
            ? (built!.legs.find((l) => l.kind === "call" && l.side === "long")!.strike! -
                built!.legs.find((l) => l.kind === "call" && l.side === "short")!.strike!)
            : (built!.legs.find((l) => l.kind === "put" && l.side === "short")!.strike! -
                built!.legs.find((l) => l.kind === "put" && l.side === "long")!.strike!);
        assert.ok(p.netFill >= wingPts * OPTION_MULT, `lizard credit ${p.netFill} < wing ${wingPts * OPTION_MULT}`);
      }
      console.log(
        `TEMPLATE ${tid}: credit fill=${p.netFill.toFixed(2)} Δ=${p.greeks.delta.toFixed(1)} BE=${p.breakevens.map((x) => x.toFixed(2)).join("/") || "—"}`,
      );
    });
  }

  it("jade lizard: single downside breakeven (no upside BE)", () => {
    const built = buildTemplate("jade_lizard", { chains: [chain45], horizonDays: 45, width: 5 });
    assert.ok(built?.legs.length);
    const p = priceStructure(built!.legs, ctx, 45);
    assert.equal(p.breakevens.length, 1, `BEs=${p.breakevens.join(",")}`);
    assert.ok(p.breakevens[0] < spot, "BE below spot");
  });
});
