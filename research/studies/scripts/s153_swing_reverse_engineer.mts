/**
 * S153 / A335 — intraday top swings vs indicator_events (recall + precision, both halves).
 * Run: research/studies/scripts/run-s153.sh
 */
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ResampledBar } from "../../../lib/indicators/src/resample.ts";
import type { TvBar } from "../../../lib/indicators/src/types.ts";

const __dir = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dir, "../../..");
const API = join(REPO, "artifacts/api-server");

function loadDatabaseUrl(): string {
  const envPath = join(REPO, ".env.local");
  const text = readFileSync(envPath, "utf8");
  const m = text.match(/^DATABASE_URL=(.+)$/m);
  if (!m) throw new Error("DATABASE_URL missing in .env.local");
  return m[1]!.replace(/^["']|["']$/g, "");
}

const indMod = await import(pathToFileURL(join(REPO, "lib/indicators/src/index.ts")).href);
const { atr, resample } = indMod;
const { squeeze } = await import(pathToFileURL(join(REPO, "lib/indicators/src/squeeze.ts")).href);
const { barCtx, preMove, PRE_TOL, PRE_BARS } = await import(pathToFileURL(join(API, "src/lib/indicator-grading.ts")).href);
const { fetchIntradayHistory } = await import(pathToFileURL(join(API, "src/lib/intraday-history.ts")).href);
const pgMod = await import(pathToFileURL(join(API, "node_modules/pg/lib/index.js")).href);
const pg = pgMod.default as typeof import("pg");
const OUT_JSON = join(__dir, "../out/s153_results.json");
const OUT_MD = join(__dir, "../S153-swing-reverse-engineer.md");
const ZZ_ATR = 1.5;
const TOP_N = 3;
const CATCH_LO = 3;
const CATCH_HI = 2;
const RANDOM_DRAWS = 2000;
const MARKET_WINDOW_SEC = 600;

type Side = "buy" | "sell";
type Swing = { ticker: string; day: string; startI: number; startSec: number; side: Side; sizeAtr: number; bars: number };
type Ev = { ticker: string; day: string; i5: number; sec: number; side: Side; indicatorId: string; kind: string; tf: string };

function sessionSlices(bars: ResampledBar[], ctx: ReturnType<typeof barCtx>): { day: string; lo: number; hi: number }[] {
  const out: { day: string; lo: number; hi: number }[] = [];
  let lo = 0;
  for (let i = 1; i <= bars.length; i++) {
    if (i === bars.length || ctx.day[i] !== ctx.day[i - 1]!) {
      out.push({ day: ctx.day[i - 1]!, lo, hi: i - 1 });
      lo = i;
    }
  }
  return out;
}

/** Zig-zag legs ≥ ZZ_ATR × ATR(14); return legs with start at pivot bar. */
function zigzagLegs(bars: ResampledBar[], atrS: number[], lo: number, hi: number): Omit<Swing, "ticker" | "day">[] {
  const legs: Omit<Swing, "ticker" | "day">[] = [];
  if (hi - lo < 5) return legs;
  let dir: 1 | -1 | 0 = 0;
  let pivotI = lo;
  let pivotPx = bars[lo]!.close;
  let legStart = lo;

  const pushLeg = (endI: number, d: 1 | -1) => {
    const a = atrS[legStart]!;
    if (!Number.isFinite(a) || a <= 0) return;
    const px0 = bars[legStart]!.close;
    const px1 = bars[endI]!.close;
    const sizeAtr = (Math.abs(px1 - px0) / a);
    if (sizeAtr < ZZ_ATR) return;
    legs.push({
      startI: legStart,
      startSec: bars[legStart]!.time,
      side: d > 0 ? "buy" : "sell",
      sizeAtr,
      bars: endI - legStart,
    });
  };

  for (let i = lo + 1; i <= hi; i++) {
    const a = atrS[i]!;
    if (!Number.isFinite(a) || a <= 0) continue;
    const thr = ZZ_ATR * a;
    const b = bars[i]!;
    if (dir === 0) {
      if (b.high - pivotPx >= thr) {
        dir = 1;
        pivotI = i;
        pivotPx = b.high;
      } else if (pivotPx - b.low >= thr) {
        dir = -1;
        pivotI = i;
        pivotPx = b.low;
      }
      continue;
    }
    if (dir === 1) {
      if (b.high > pivotPx) {
        pivotPx = b.high;
        pivotI = i;
      } else if (pivotPx - b.low >= thr) {
        pushLeg(pivotI, 1);
        legStart = pivotI;
        dir = -1;
        pivotPx = b.low;
        pivotI = i;
      }
    } else {
      if (b.low < pivotPx) {
        pivotPx = b.low;
        pivotI = i;
      } else if (b.high - pivotPx >= thr) {
        pushLeg(pivotI, -1);
        legStart = pivotI;
        dir = 1;
        pivotPx = b.high;
        pivotI = i;
      }
    }
  }
  return legs;
}

function topSwingsPerDay(all: Swing[]): Swing[] {
  const by = new Map<string, Swing[]>();
  for (const s of all) {
    const k = `${s.ticker}|${s.day}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k)!.push(s);
  }
  const out: Swing[] = [];
  for (const arr of by.values()) {
    arr.sort((a, b) => b.sizeAtr - a.sizeAtr);
    out.push(...arr.slice(0, TOP_N));
  }
  return out;
}

function catchWindow(swingI: number, evI: number): boolean {
  return evI >= swingI - CATCH_LO && evI <= swingI + CATCH_HI;
}

function timeBucket(modMin: number): string {
  if (modMin < 10 * 60 + 30) return "open"; // 9:30–10:30 ET
  if (modMin < 14 * 60) return "mid";
  return "close";
}

function etToPtLabel(day: string, modMin: number): string {
  let m = modMin - 180; // ET → PT (Nov = PST)
  let d = day;
  if (m < 0) {
    m += 24 * 60;
    const [y, mo, dd] = day.split("-").map(Number);
    const dt = new Date(Date.UTC(y!, mo! - 1, dd!));
    dt.setUTCDate(dt.getUTCDate() - 1);
    d = dt.toISOString().slice(0, 10);
  }
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return `${d} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} PT`;
}

async function loadEvents(client: pg.Client, tickers: string[]): Promise<Ev[]> {
  const r = await client.query<{ ticker: string; tf: string; indicator_id: string; kind: string; side: string; sec: string }>(
    `select ticker, tf, indicator_id, kind, side, extract(epoch from time)::bigint::text as sec
     from indicator_events where side in ('buy','sell')`,
  );
  return r.rows.map((row) => ({
    ticker: row.ticker,
    tf: row.tf,
    indicatorId: row.indicator_id,
    kind: row.kind,
    side: row.side as Side,
    sec: Number(row.sec),
    day: "",
    i5: -1,
  }));
}

async function main() {
  const client = new pg.Client({ connectionString: loadDatabaseUrl() });
  await client.connect();
  const tickersR = await client.query<{ ticker: string }>(`select distinct ticker from indicator_events order by 1`);
  const tickers = tickersR.rows.map((r) => r.ticker);
  console.log(`tickers=${tickers.length}`);

  const eventsRaw = await loadEvents(client, tickers);
  const barByTicker = new Map<string, { bars5: ResampledBar[]; ctx: ReturnType<typeof barCtx>; atrS: number[]; pre: number[]; idx: Map<number, number> }>();

  for (let ti = 0; ti < tickers.length; ti++) {
    const ticker = tickers[ti]!;
    process.stderr.write(`fetch ${ti + 1}/${tickers.length} ${ticker}\n`);
    const sessions = await fetchIntradayHistory(ticker, 60);
    const b5: TvBar[] = [];
    for (const date of [...sessions.keys()].sort()) {
      for (const b of sessions.get(date)!) {
        b5.push({ time: Math.floor(b.time / 1000), open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });
      }
    }
    if (b5.length < 200) continue;
    const bars5 = resample(b5, 5);
    const ctx = barCtx(bars5);
    const atrS = atr(bars5, 14);
    const pre = preMove(bars5, atrS);
    const idx = new Map(bars5.map((b, i) => [b.time, i]));
    barByTicker.set(ticker, { bars5, ctx, atrS, pre, idx });
  }

  const allSwings: Swing[] = [];
  for (const [ticker, pack] of barByTicker) {
    for (const { day, lo, hi } of sessionSlices(pack.bars5, pack.ctx)) {
      for (const leg of zigzagLegs(pack.bars5, pack.atrS, lo, hi)) {
        allSwings.push({ ticker, day, ...leg });
      }
    }
  }
  const swings = topSwingsPerDay(allSwings);
  const swingDays = [...new Set(swings.map((s) => s.day))].sort();
  const midDay = swingDays[Math.floor(swingDays.length / 2)]!;
  const half = (d: string) => (d <= midDay ? "h1" : "h2");

  // Map events to 5m bar index + day
  const events: Ev[] = [];
  for (const e of eventsRaw) {
    const pack = barByTicker.get(e.ticker);
    if (!pack) continue;
    // nearest 5m bar at or before event time
    let bestI = -1;
    let bestT = -1;
    for (let i = 0; i < pack.bars5.length; i++) {
      const t = pack.bars5[i]!.time;
      if (t <= e.sec && t > bestT) {
        bestT = t;
        bestI = i;
      }
    }
    if (bestI < 0) continue;
    e.i5 = bestI;
    e.day = pack.ctx.day[bestI]!;
    events.push(e);
  }

  const swingSet = swings;
  const swingKey = (s: Swing) => `${s.ticker}|${s.day}|${s.startI}`;

  function swingCaught(s: Swing, evs: Ev[]): boolean {
    return evs.some((e) => e.ticker === s.ticker && e.day === s.day && e.side === s.side && catchWindow(s.startI, e.i5));
  }

  const indicators = [...new Set(events.map((e) => e.indicatorId))].sort();
  type Row = { indicatorId: string; kind: string; recall: number; precision: number; basePrec: number; nSwings: number; nEv: number; nHit: number };
  const rows: Row[] = [];

  for (const indicatorId of indicators) {
    const kinds = [...new Set(events.filter((e) => e.indicatorId === indicatorId).map((e) => e.kind))].sort();
    for (const kind of kinds) {
      const evSub = events.filter((e) => e.indicatorId === indicatorId && e.kind === kind);
      let caught = 0;
      for (const s of swingSet) if (swingCaught(s, evSub)) caught++;
      let hit = 0;
      for (const e of evSub) {
        const near = swingSet.some(
          (s) => s.ticker === e.ticker && s.day === e.day && s.side === e.side && catchWindow(s.startI, e.i5),
        );
        if (near) hit++;
      }
      rows.push({
        indicatorId,
        kind,
        recall: swingSet.length ? caught / swingSet.length : 0,
        precision: evSub.length ? hit / evSub.length : 0,
        basePrec: 0,
        nSwings: swingSet.length,
        nEv: evSub.length,
        nHit: hit,
      });
    }
  }

  // Vol-matched random bar base precision (pooled)
  const rng = mulberry32(153);
  let randHit = 0;
  let randN = 0;
  const swingByTickerDay = new Map<string, Swing[]>();
  for (const s of swingSet) {
    const k = `${s.ticker}|${s.day}`;
    if (!swingByTickerDay.has(k)) swingByTickerDay.set(k, []);
    swingByTickerDay.get(k)!.push(s);
  }
  for (const [ticker, pack] of barByTicker) {
    for (const { day, lo, hi } of sessionSlices(pack.bars5, pack.ctx)) {
      const daySw = swingByTickerDay.get(`${ticker}|${day}`) ?? [];
      if (!daySw.length) continue;
      const cands: number[] = [];
      for (let i = lo + PRE_BARS; i <= hi; i++) {
        if (!Number.isFinite(pack.pre[i]!)) continue;
        if (pack.bars5[i]!.lastTime + 300 < pack.bars5[i]!.end) continue;
        cands.push(i);
      }
      if (cands.length < 5) continue;
      for (let d = 0; d < 30; d++) {
        const i = cands[Math.floor(rng() * cands.length)]!;
        const p0 = pack.pre[i]!;
        const matched = cands.filter((j) => Math.abs(pack.pre[j]! - p0) <= PRE_TOL);
        const pool = matched.length >= 5 ? matched : cands;
        const j = pool[Math.floor(rng() * pool.length)]!;
        const side: Side = rng() > 0.5 ? "buy" : "sell";
        randN++;
        if (daySw.some((s) => s.side === side && catchWindow(s.startI, j))) randHit++;
      }
    }
  }
  const basePrec = randN ? randHit / randN : 0;
  for (const r of rows) r.basePrec = basePrec;

  // SPY+QQQ market filter index
  const idxEvents = events.filter((e) => e.ticker === "SPY" || e.ticker === "QQQ");
  function marketAgree(e: Ev): boolean {
    const t0 = e.sec;
    const spy = idxEvents.some((x) => x.ticker === "SPY" && x.side === e.side && Math.abs(x.sec - t0) <= MARKET_WINDOW_SEC);
    const qqq = idxEvents.some((x) => x.ticker === "QQQ" && x.side === e.side && Math.abs(x.sec - t0) <= MARKET_WINDOW_SEC);
    return spy && qqq;
  }

  // Squeeze-on at bar (LazyBear state)
  const squeezeOn = new Map<string, boolean>();
  for (const [ticker, pack] of barByTicker) {
    const sq = squeeze(pack.bars5);
    for (let i = 0; i < pack.bars5.length; i++) {
      squeezeOn.set(`${ticker}|${i}`, sq.state[i] === "on");
    }
  }

  function multiTfAgree(e: Ev): boolean {
    if (e.tf === "5m") {
      return events.some(
        (o) =>
          o.ticker === e.ticker &&
          o.day === e.day &&
          o.side === e.side &&
          o.indicatorId === e.indicatorId &&
          o.kind === e.kind &&
          o.tf === "15m" &&
          Math.abs(o.i5 - e.i5) <= 3,
      );
    }
    return false;
  }

  type FilterDef = { name: string; pred: (e: Ev) => boolean };
  const filters: FilterDef[] = [
    { name: "open_9:30-10:30_ET", pred: (e) => {
      const pack = barByTicker.get(e.ticker);
      if (!pack) return false;
      return timeBucket(pack.ctx.mod[e.i5]!) === "open";
    }},
    { name: "mid_10:30-14:00_ET", pred: (e) => {
      const pack = barByTicker.get(e.ticker);
      if (!pack) return false;
      return timeBucket(pack.ctx.mod[e.i5]!) === "mid";
    }},
    { name: "SPY+QQQ_same_side_10m", pred: marketAgree },
    { name: "squeeze_on", pred: (e) => squeezeOn.get(`${e.ticker}|${e.i5}`) === true },
    { name: "5m+15m_same_side", pred: multiTfAgree },
  ];

  type FilterRow = { name: string; h1: { prec: number; n: number }; h2: { prec: number; n: number }; liftH1: number; liftH2: number; pass: boolean };
  const filterRows: FilterRow[] = [];
  const allEv = events;
  for (const f of filters) {
    const halves = { h1: { hit: 0, n: 0 }, h2: { hit: 0, n: 0 } };
    for (const e of allEv) {
      if (!f.pred(e)) continue;
      const h = half(e.day) as "h1" | "h2";
      halves[h].n++;
      const near = swingSet.some(
        (s) => s.ticker === e.ticker && s.day === e.day && s.side === e.side && catchWindow(s.startI, e.i5),
      );
      if (near) halves[h].hit++;
    }
    const h1prec = halves.h1.n ? halves.h1.hit / halves.h1.n : 0;
    const h2prec = halves.h2.n ? halves.h2.hit / halves.h2.n : 0;
    filterRows.push({
      name: f.name,
      h1: { prec: h1prec, n: halves.h1.n },
      h2: { prec: h2prec, n: halves.h2.n },
      liftH1: basePrec > 0 ? h1prec / basePrec : 0,
      liftH2: basePrec > 0 ? h2prec / basePrec : 0,
      pass: halves.h1.n >= 50 && halves.h2.n >= 50 && h1prec >= 1.5 * basePrec && h2prec >= 1.5 * basePrec,
    });
  }
  filterRows.sort((a, b) => Math.max(b.liftH1, b.liftH2) - Math.max(a.liftH1, a.liftH2));

  // Example days: top swing size days with UT catches
  const utEv = events.filter((e) => e.indicatorId === "ut");
  const dayScores = new Map<string, { maxAtr: number; swings: Swing[] }>();
  for (const s of swingSet) {
    const k = s.day;
    if (!dayScores.has(k)) dayScores.set(k, { maxAtr: 0, swings: [] });
    const d = dayScores.get(k)!;
    d.swings.push(s);
    if (s.sizeAtr > d.maxAtr) d.maxAtr = s.sizeAtr;
  }
  const exampleDays = [...dayScores.entries()]
    .sort((a, b) => b[1].maxAtr - a[1].maxAtr)
    .slice(0, 5)
    .map(([day, info]) => {
      const lines = info.swings
        .sort((a, b) => b.sizeAtr - a.sizeAtr)
        .slice(0, 3)
        .map((s) => {
          const pack = barByTicker.get(s.ticker)!;
          const pt = etToPtLabel(s.day, pack.ctx.mod[s.startI]!);
          const caught = swingCaught(s, utEv) ? "UT" : swingCaught(s, events) ? "other" : "none";
          return `${s.ticker} ${s.side} ${s.sizeAtr.toFixed(1)}ATR @ ${pt} catch=${caught}`;
        });
      return { day, lines };
    })
    .slice(0, 3);

  const summary = {
    tickers: barByTicker.size,
    sessions: swingDays.length,
    swings: swingSet.length,
    events: events.length,
    basePrec,
    midDay,
    rows: rows.sort((a, b) => b.recall - a.recall || b.precision - a.precision),
    filterRows,
    exampleDays,
  };

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, JSON.stringify(summary, null, 2));

  const md = buildMd(summary);
  writeFileSync(OUT_MD, md);
  console.log(`wrote ${OUT_MD}`);
  console.log(`swings=${swingSet.length} basePrec=${(basePrec * 100).toFixed(2)}%`);
  await client.end();
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildMd(s: Awaited<ReturnType<typeof main>> extends void ? never : Record<string, unknown>): string {
  const sum = s as {
    tickers: number;
    sessions: number;
    swings: number;
    events: number;
    basePrec: number;
    midDay: string;
    rows: { indicatorId: string; kind: string; recall: number; precision: number; basePrec: number; nEv: number }[];
    filterRows: { name: string; h1: { prec: number; n: number }; h2: { prec: number; n: number }; liftH1: number; liftH2: number; pass: boolean }[];
    exampleDays: { day: string; lines: string[] }[];
  };
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    "# S153 — intraday top swings vs indicator events (A335)",
    "",
    `Universe: ${sum.tickers} tickers with Yahoo 5m (~60d). Labels: zig-zag legs ≥ ${ZZ_ATR} ATR(14), top ${TOP_N} per ticker-day (${sum.swings} swings over ${sum.sessions} session-days). Catch window: [start−${CATCH_LO}, start+${CATCH_HI}] on 5m bars, same side. Half split at ${sum.midDay}.`,
    "",
    `**Random vol-matched base precision** (preMove ±${PRE_TOL}): **${pct(sum.basePrec)}**`,
    "",
    "## Recall / precision by indicator × kind",
    "",
    "| indicator | kind | recall | precision | vs base | n events |",
    "|---|---:|---:|---:|---:|---:|",
  ];
  for (const r of sum.rows.slice(0, 30)) {
    lines.push(`| ${r.indicatorId} | ${r.kind} | ${pct(r.recall)} | ${pct(r.precision)} | ${(r.precision / r.basePrec).toFixed(2)}× | ${r.nEv} |`);
  }
  lines.push("", "## Context filters (precision lift ≥1.5× base, n≥50 both halves)", "", "| filter | H1 prec (n) | H2 prec (n) | lift H1/H2 | pass |", "|---|---:|---:|---:|:---:|");
  for (const f of sum.filterRows) {
    lines.push(
      `| ${f.name} | ${pct(f.h1.prec)} (${f.h1.n}) | ${pct(f.h2.prec)} (${f.h2.n}) | ${f.liftH1.toFixed(2)}/${f.liftH2.toFixed(2)} | ${f.pass ? "Y" : "n"} |`,
    );
  }
  lines.push("", "## Example session-days (largest swings; UT catch noted)", "");
  for (const ex of sum.exampleDays) {
    lines.push(`### ${ex.day}`, ...ex.lines.map((l) => `- ${l}`), "");
  }
  lines.push("", "## Verdict", "");
  const best = sum.rows.filter((r) => r.nEv >= 100).sort((a, b) => b.recall - a.recall)[0];
  const passedFilters = sum.filterRows.filter((f) => f.pass);
  lines.push(
    best
      ? `Highest recall among n≥100 events: **${best.indicatorId} / ${best.kind}** recall ${pct(best.recall)}, precision ${pct(best.precision)} (${(best.precision / best.basePrec).toFixed(2)}× base).`
      : "No indicator crossed n≥100.",
    passedFilters.length
      ? `Filters passing preregistered bar: **${passedFilters.map((f) => f.name).join(", ")}**.`
      : "**No context filter** met 1.5× base precision in both halves with n≥50.",
    "Recall answers “did the indicator see the big swing”; precision answers “was this signal one of those swings”. Neither replaces round-trip grading (A334).",
  );
  return lines.join("\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
