/**
 * A318 segments 1+2 — re-merge, fund_score delta, stratified eval sample (seed 318).
 * Zero FactSet API calls.
 */
import { sql } from "drizzle-orm";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db, tickerFundamentals, type TickerFundamentalsRow } from "@workspace/db";
import { eq } from "drizzle-orm";
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "../routes/regime.js";
import { attributeLargestGoldField } from "../lib/a318-fund-delta.js";
import { runMergeTrusted } from "./merge-trusted.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../out/a318-segment12");
const EVAL_PATH = join(REPO_ROOT, "research/common/asks/A318-seg12-eval.json");

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function scoredBookTickers(): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT UPPER(ticker) AS ticker FROM model_recs
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM model_recs)
    UNION
    SELECT DISTINCT UPPER(ticker) AS ticker FROM option_score_snapshots
    WHERE as_of = (SELECT MAX(as_of) FROM option_score_snapshots)
  `);
  const list = (Array.isArray(res) ? res : (res as unknown as { rows?: { ticker: string }[] }).rows) ?? [];
  return list.map((r) => String(r.ticker).toUpperCase());
}

async function ensureAfterSeg0Baseline() {
  const chk = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'a318_prov_after_seg0'
  `);
  const rows = (Array.isArray(chk) ? chk : (chk as unknown as { rows?: { n: number }[] }).rows) ?? [];
  if (Number(rows[0]?.n ?? 0) === 0) {
    await db.execute(sql.raw(`
      CREATE TABLE a318_prov_after_seg0 AS
      SELECT ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at
      FROM field_provenance
    `));
    return;
  }
  const cnt = await db.execute(sql`SELECT COUNT(*)::int AS n FROM a318_prov_after_seg0`);
  const cRows = (Array.isArray(cnt) ? cnt : (cnt as unknown as { rows?: { n: number }[] }).rows) ?? [];
  if (Number(cRows[0]?.n ?? 0) === 0) {
    await db.execute(sql`
      INSERT INTO a318_prov_after_seg0 (ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at)
      SELECT ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at FROM field_provenance
    `);
  }
}

type GoldCell = {
  ticker: string;
  field: string;
  beforeGold: string;
  afterGold: string;
  beforeSource: string;
  afterSource: string;
  period: string | null;
};

async function changedCells012(scored: Set<string>): Promise<GoldCell[]> {
  await ensureBeforeSeg0Table();
  await ensureAfterSeg0Baseline();
  let res;
  try {
    res = await db.execute(sql`
    SELECT fp.ticker, fp.field,
           b.winning_value::text AS before_gold,
           fp.winning_value::text AS after_gold,
           b.winning_source AS before_source,
           fp.winning_source AS after_source,
           fp.fetched_at AS period
    FROM field_provenance fp
    INNER JOIN a318_prov_before_seg0 b ON fp.ticker = b.ticker AND fp.field = b.field
    WHERE (fp.winning_value IS DISTINCT FROM b.winning_value
           OR fp.winning_source IS DISTINCT FROM b.winning_source)
  `);
  } catch {
    return [];
  }
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? [];
  const out: GoldCell[] = [];
  for (const r of rows as {
    ticker: string;
    field: string;
    before_gold: string;
    after_gold: string;
    before_source: string;
    after_source: string;
    period: Date | null;
  }[]) {
    if (!scored.has(String(r.ticker).toUpperCase())) continue;
    out.push({
      ticker: r.ticker,
      field: r.field,
      beforeGold: r.before_gold,
      afterGold: r.after_gold,
      beforeSource: r.before_source,
      afterSource: r.after_source,
      period: r.period ? new Date(r.period).toISOString().slice(0, 10) : null,
    });
  }
  return out;
}

function stratifiedSample(cells: GoldCell[], n: number, seed: number): GoldCell[] {
  if (cells.length === 0) return [];
  const byField = new Map<string, GoldCell[]>();
  for (const c of cells) {
    if (!byField.has(c.field)) byField.set(c.field, []);
    byField.get(c.field)!.push(c);
  }
  const rng = mulberry32(seed);
  const picked: GoldCell[] = [];
  let fi = 0;
  while (picked.length < n && byField.size > 0) {
    const liveFields = [...byField.keys()].sort();
    if (liveFields.length === 0) break;
    const field = liveFields[fi % liveFields.length]!;
    const pool = byField.get(field);
    if (!pool || pool.length === 0) {
      byField.delete(field);
      fi++;
      continue;
    }
    const idx = Math.floor(rng() * pool.length);
    picked.push(pool.splice(idx, 1)[0]!);
    if (pool.length === 0) byField.delete(field);
    fi++;
  }
  return picked.slice(0, n);
}

async function scoreDelta() {
  const res = await db.execute(sql`
    SELECT b.ticker,
           b.fund_total::float8 AS before,
           t.fund_total_score::float8 AS after
    FROM a318_segment0_fund_score_before b
    JOIN ticker_fundamentals t ON UPPER(t.ticker) = b.ticker
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? [];
  const deltas: { ticker: string; before: number; after: number; delta: number }[] = [];
  for (const r of rows as { ticker: string; before: number | null; after: number | null }[]) {
    const b = r.before;
    const a = r.after;
    if (b == null || a == null || !Number.isFinite(b) || !Number.isFinite(a)) continue;
    if (Math.abs(a - b) < 1e-9) continue;
    deltas.push({ ticker: r.ticker, before: b, after: a, delta: a - b });
  }
  const absD = deltas.map((d) => Math.abs(d.delta)).sort((x, y) => x - y);
  const medianAbs = absD.length ? absD[Math.floor(absD.length / 2)]! : 0;
  const top10 = [...deltas]
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 10)
    .map((d) => ({ ticker: d.ticker, delta: d.delta, field: "?" as string }));
  return { nChanged: deltas.length, medianAbs, movers: top10 };
}

async function ensureTfAtSeg0(scored: Set<string>) {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS a318_tf_at_seg0 (ticker text PRIMARY KEY, row jsonb NOT NULL)
  `));
  const cnt = await db.execute(sql`SELECT COUNT(*)::int AS n FROM a318_tf_at_seg0`);
  const cRows = (Array.isArray(cnt) ? cnt : (cnt as unknown as { rows?: { n: number }[] }).rows) ?? [];
  if (Number(cRows[0]?.n ?? 0) > 0) return;
  const rows = await db.select().from(tickerFundamentals);
  for (const r of rows) {
    if (!scored.has(r.ticker.toUpperCase())) continue;
    await db.execute(sql`
      INSERT INTO a318_tf_at_seg0 (ticker, row) VALUES (${r.ticker.toUpperCase()}, ${JSON.stringify(r)}::jsonb)
      ON CONFLICT (ticker) DO NOTHING
    `);
  }
}

async function snapshotPreMerge() {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS a318_prov_pre_merge AS
    SELECT ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at
    FROM field_provenance WHERE false
  `));
  await db.execute(sql.raw(`TRUNCATE a318_prov_pre_merge`));
  await db.execute(sql`
    INSERT INTO a318_prov_pre_merge (ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at)
    SELECT ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at FROM field_provenance
  `);
}

async function snapshotTfPreMerge() {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS a318_tf_pre_merge (
      ticker text PRIMARY KEY,
      row jsonb NOT NULL
    )
  `));
  await db.execute(sql.raw(`TRUNCATE a318_tf_pre_merge`));
  const rows = await db.select().from(tickerFundamentals);
  for (const r of rows) {
    await db.execute(sql`
      INSERT INTO a318_tf_pre_merge (ticker, row) VALUES (${r.ticker.toUpperCase()}, ${JSON.stringify(r)}::jsonb)
    `);
  }
}

async function topGoldFieldForTicker(ticker: string): Promise<string | null> {
  const snap = await db.execute(sql`
    SELECT row FROM a318_tf_at_seg0 WHERE ticker = ${ticker.toUpperCase()} LIMIT 1
  `);
  const snapRows = (Array.isArray(snap) ? snap : (snap as unknown as { rows?: { row: TickerFundamentalsRow }[] }).rows) ?? [];
  const before = snapRows[0]?.row;
  if (!before) return null;
  const beforeRow = (typeof before === "string" ? JSON.parse(before) : before) as TickerFundamentalsRow;
  const afterRows = await db.select().from(tickerFundamentals).where(eq(tickerFundamentals.ticker, ticker.toUpperCase())).limit(1);
  const after = afterRows[0];
  if (!after) return null;
  const field = attributeLargestGoldField(beforeRow, after);
  if (field) return field;
  const prov = await db.execute(sql`
    SELECT fp.field
    FROM field_provenance fp
    INNER JOIN a318_prov_pre_merge b ON fp.ticker = b.ticker AND fp.field = b.field
    WHERE UPPER(fp.ticker) = ${ticker.toUpperCase()}
      AND (fp.winning_value IS DISTINCT FROM b.winning_value OR fp.winning_source IS DISTINCT FROM b.winning_source)
    ORDER BY ABS(fp.winning_value::float8 - b.winning_value::float8) DESC NULLS LAST
    LIMIT 1
  `);
  const pRows = (Array.isArray(prov) ? prov : (prov as unknown as { rows?: { field: string }[] }).rows) ?? [];
  return pRows[0]?.field ?? "peer_recalc";
}

async function ensureBeforeSeg0Table() {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS a318_prov_before_seg0 AS
    SELECT ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at
    FROM field_provenance WHERE false
  `));
  const cnt = await db.execute(sql`SELECT COUNT(*)::int AS n FROM a318_prov_before_seg0`);
  const cRows = (Array.isArray(cnt) ? cnt : (cnt as unknown as { rows?: { n: number }[] }).rows) ?? [];
  if (Number(cRows[0]?.n ?? 0) > 0) return;
  await ensureAfterSeg0Baseline();
  const afterCnt = await db.execute(sql`SELECT COUNT(*)::int AS n FROM a318_prov_after_seg0`);
  const aRows = (Array.isArray(afterCnt) ? afterCnt : (afterCnt as unknown as { rows?: { n: number }[] }).rows) ?? [];
  if (Number(aRows[0]?.n ?? 0) > 0) {
    await db.execute(sql`
      INSERT INTO a318_prov_before_seg0 (ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at)
      SELECT ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at FROM a318_prov_after_seg0
    `);
    return;
  }
  await db.execute(sql`
    INSERT INTO a318_prov_before_seg0 (ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at)
    SELECT ticker, field, winning_source, winning_value, divergent, fetched_at, updated_at FROM field_provenance
  `);
}

async function main() {
  const scored = new Set(await scoredBookTickers());
  console.error(`[a318-s12] scored book n=${scored.size}`);

  await ensureBeforeSeg0Table();
  await ensureTfAtSeg0(scored);
  await snapshotPreMerge();
  await snapshotTfPreMerge();

  console.error("[a318-s12] merge-trusted…");
  await runMergeTrusted();
  const regime = await getLatestRegime();
  await computeAndPersistFundamentalScores(regime);

  const changed = await changedCells012(scored);
  const sample = stratifiedSample(changed, 30, 318);
  const fundScore = await scoreDelta();
  for (const m of fundScore.movers) {
    m.field = (await topGoldFieldForTicker(m.ticker)) ?? "peer_recalc";
  }

  let factsetDisagrees: unknown = { count: 0, byField: {} };
  try {
    factsetDisagrees = JSON.parse(
      readFileSync(join(OUT_DIR, "factset-disagrees.json"), "utf8"),
    );
  } catch {
    /* merge may have written none */
  }

  const packet = {
    seed: 318,
    scoredBookCellsChanged012: changed.length,
    evalSample: sample.map((c) => ({
      ticker: c.ticker,
      field: c.field,
      beforeGold: c.beforeGold,
      afterGold: c.afterGold,
      source: c.afterSource,
      period: c.period,
    })),
    fundScore,
    factsetDisagrees,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "packet.json"), JSON.stringify(packet, null, 2) + "\n");
  writeFileSync(EVAL_PATH, JSON.stringify({ sample: packet.evalSample, poolSize: changed.length }, null, 2) + "\n");
  console.log(JSON.stringify({ changed: changed.length, sample: sample.length, fundScore }));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
