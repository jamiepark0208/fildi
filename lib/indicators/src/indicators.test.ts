import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { INDICATORS, TV_INDICATORS, type IndResult, type TvBar } from "./index.ts";
import { ichimoku } from "./ichimoku.ts";
import { lsh } from "./lsh.ts";
import { mso } from "./mso.ts";
import { squeeze } from "./squeeze.ts";

type Fixture = { rows: [number, number, number, number, number, number][] };
const load = (name: string): TvBar[] =>
  (JSON.parse(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), "utf8")) as Fixture).rows.map(
    ([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }),
  );
const bars5d = load("spy-5m-5d.json");
const bars1mo = load("spy-5m-1mo.json");

const same = (a: number, b: number) => (Number.isNaN(a) ? Number.isNaN(b) : a === b);

/** First `k` bars of every output must equal the same bars computed on the truncated input. */
function assertNoLookAhead(id: string, bars: TvBar[], cuts: number[]) {
  const ind = TV_INDICATORS.find((x) => x.id === id)!;
  const full = ind.compute(bars);
  for (const k of cuts) {
    const part = ind.compute(bars.slice(0, k));
    assert.equal(part.lines.length, full.lines.length);
    full.lines.forEach((ln, li) => {
      for (let i = 0; i < k; i++) {
        assert.ok(same(ln.values[i]!, part.lines[li]!.values[i]!), `${id} line ${ln.key} bar ${i} changed with cut ${k}`);
        assert.equal(ln.colors?.[i] ?? null, part.lines[li]!.colors?.[i] ?? null, `${id} colour ${ln.key} bar ${i}`);
      }
    });
    if (full.hist) for (let i = 0; i < k; i++) assert.ok(same(full.hist.values[i]!, part.hist!.values[i]!), `${id} hist bar ${i} cut ${k}`);
    const fm = full.markers.filter((m) => m.i < k), pm = part.markers;
    assert.deepEqual(pm, fm, `${id} markers changed with cut ${k}`);
  }
}

function finiteFrom(res: IndResult, from: number, id: string) {
  const arrays = [...res.lines.filter((l) => id !== "lsh" && id !== "ichimoku").map((l) => l.values), ...(res.hist ? [res.hist.values] : [])];
  for (const a of arrays) for (let i = from; i < a.length; i++) assert.ok(Number.isFinite(a[i]!), `${id} NaN after warm-up at ${i}`);
}

describe("fixtures", () => {
  it("are real SPY 5m sessions", () => {
    assert.ok(bars5d.length > 300 && bars1mo.length > 1500);
    assert.ok(bars1mo.every((b, i) => i === 0 || b.time > bars1mo[i - 1]!.time));
  });
});

describe("no look-ahead", () => {
  for (const ind of TV_INDICATORS) {
    it(ind.id, () => assertNoLookAhead(ind.id, bars1mo.slice(0, 900), [200, 407, 650, 899]));
  }
});

describe("indicator defs (plug-in contract)", () => {
  it("every def has source/version/timeframes and its events carry buy|sell|neutral, a kind, a finite entry price", () => {
    for (const d of INDICATORS) {
      assert.ok(d.version >= 1 && d.source.url && d.source.author && d.source.license, d.id);
      assert.deepEqual(d.timeframes, ["5m", "15m", "1h"]);
      const out = d.compute(bars1mo);
      for (const e of out.events) assert.ok(["buy", "sell", "neutral"].includes(e.side) && e.kind && Number.isFinite(e.price) && Number.isFinite(e.time), `${d.id} event`);
      for (const l of out.view.lines) assert.ok(out.series[l.key], `${d.id} view line ${l.key} has a series`);
    }
  });
  it("events at bar i are unchanged when later bars are removed (no look-ahead)", () => {
    const full = bars1mo.slice(0, 900);
    for (const d of INDICATORS) {
      const all = d.compute(full).events;
      for (const k of [300, 500, 700]) {
        const cutT = full[k - 1]!.time;
        const part = d.compute(full.slice(0, k)).events;
        assert.deepEqual(part, all.filter((e) => e.time <= cutT), `${d.id} events changed with cut ${k}`);
      }
    }
  });
  it("ut, st, ichimoku, squeeze, mso, lsh each yield events on the 1mo fixture except where rare (lsh may be sparse)", () => {
    for (const id of ["ut", "st", "ichimoku", "squeeze", "mso"]) assert.ok(INDICATORS.find((d) => d.id === id)!.compute(bars1mo).events.length > 0, id);
  });
});

describe("indicators on SPY 5m", () => {
  it("every output is finite after warm-up (1mo)", () => {
    for (const ind of TV_INDICATORS) finiteFrom(ind.compute(bars1mo), 120, ind.id);
  });
  it("ichimoku: lines finite from the 52nd bar, TV displacement shift 25", () => {
    const r = ichimoku(bars5d);
    assert.equal(r.shift, 25);
    for (let i = 51; i < bars5d.length; i++) assert.ok([r.conversion, r.base, r.spanA, r.spanB].every((s) => Number.isFinite(s[i]!)));
    // conversion = (highest 9 high + lowest 9 low) / 2
    const i = 100, w = bars5d.slice(i - 8, i + 1);
    assert.equal(r.conversion[i], (Math.max(...w.map((b) => b.high)) + Math.min(...w.map((b) => b.low))) / 2);
    assert.equal(r.spanA[i], (r.conversion[i]! + r.base[i]!) / 2);
  });
  it("squeeze: states and momentum events exist; momentum finite from bar 38 (linreg over a 19-bar-warm source)", () => {
    const r = squeeze(bars1mo);
    assert.ok(r.events.length > 0);
    assert.ok(r.state.filter((s) => s === "on").length > 0 && r.state.filter((s) => s === "off").length > 0);
    for (let i = 40; i < bars1mo.length; i++) assert.ok(Number.isFinite(r.val[i]!) && r.barColor[i] && r.state[i]);
  });
  it("squeeze quirk: BB deviation uses multKC, so the BB mult input has no effect", () => {
    const a = squeeze(bars1mo.slice(0, 500), { bbMult: 2.0 });
    const b = squeeze(bars1mo.slice(0, 500), { bbMult: 9.0 });
    assert.deepEqual(a.state, b.state);
    // Consequence of the quirk: both bands scale by kcMult, so on/off reduces to stdev < SMA(true range) at any kcMult.
    const c = squeeze(bars1mo.slice(0, 500), { kcMult: 2.5 });
    assert.deepEqual(a.state, c.state);
    const d = squeeze(bars1mo.slice(0, 500), { kcLength: 30 });
    assert.notDeepEqual(a.state, d.state);
  });
  it("mso: breaks (CHoCH then BoS) and divergences exist; osc in 0..100", () => {
    const r = mso(bars1mo);
    assert.ok(r.breaks.length > 0 && r.divergences.length > 0);
    assert.ok(r.breaks.some((b) => b.kind === "CHoCH") && r.breaks.some((b) => b.kind === "BoS"));
    for (const v of r.osc) assert.ok(Number.isNaN(v) || (v >= 0 && v <= 100));
    for (const b of r.breaks) assert.ok(b.swingBar < b.i);
    for (let i = 60; i < bars1mo.length; i++) assert.ok(Number.isFinite(r.trendFilteredOsc[i]!));
  });
  it("mso on 5d fixture also yields breaks", () => assert.ok(mso(bars5d).breaks.length > 0));
  it("lsh: highs/lows and sweep signals exist; no NaN prices", () => {
    const r = lsh(bars1mo);
    assert.ok(r.levels.length > 0 && r.signals.length > 0);
    assert.ok(r.levels.some((l) => l.side === "high") && r.levels.some((l) => l.side === "low"));
    // Looser strength filter can only add signals.
    assert.ok(lsh(bars1mo, { filterSweepsByStrength: false }).signals.length >= r.signals.length);
    assert.ok(r.levels.every((l) => Number.isFinite(l.price)));
    assert.ok(r.signals.every((s) => Number.isFinite(s.price) && s.i >= s.sweepBar));
    assert.ok(r.levels.some((l) => l.removedBy === "mitigated"));
  });
  it("lsh audit lock (11-04): default gates give 1 signal on the 1mo fixture; no strength filter gives 3 (rare by design: 2+ distinct swept bands, then a reclaim within 2 bars)", () => {
    assert.equal(lsh(bars1mo).signals.length, 1);
    assert.equal(lsh(bars1mo, { filterSweepsByStrength: false }).signals.length, 3);
  });
  it("lsh on the 5d fixture builds fast/mid levels", () => assert.ok(lsh(bars5d).levels.length > 0));
  it("ut/st produce events on the registry path", () => {
    const ut = TV_INDICATORS.find((x) => x.id === "ut")!.compute(bars1mo);
    assert.ok(ut.markers.length > 0 && ut.markers.every((m) => m.i >= 0));
    const st = TV_INDICATORS.find((x) => x.id === "st")!.compute(bars1mo);
    assert.ok(st.lines[0]!.values.some(Number.isFinite));
  });
  it("registry lists each id once (core 8 present), title is one line", () => {
    const ids = TV_INDICATORS.map((x) => x.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ["ichimoku", "lsh", "macd", "mso", "rsi", "squeeze", "st", "ut"]) assert.ok(ids.includes(id as never), id);
    for (const x of TV_INDICATORS) assert.ok(x.title.length < 110 && !x.title.includes("\n"));
  });
});
