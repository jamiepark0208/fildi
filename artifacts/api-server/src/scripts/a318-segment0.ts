/**
 * A318 segment 0 — snapshot scored-book fund_score, rebuild ruler JSON, re-merge + recompute, report packet.
 * Zero FactSet API calls.
 */
import { sql } from "drizzle-orm";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "@workspace/db";
import { loadRulerTable } from "../lib/factset-ruler-table.js";
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "../routes/regime.js";
import { runMergeTrusted } from "./merge-trusted.js";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../out/a318-segment0");
const SNAPSHOT_TABLE = "a318_segment0_fund_score_before";

async function scoredBookTickers(): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT UPPER(ticker) AS ticker FROM model_recs
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM model_recs)
    UNION
    SELECT DISTINCT UPPER(ticker) AS ticker FROM option_score_snapshots
    WHERE as_of = (SELECT MAX(as_of) FROM option_score_snapshots)
  `);
  const list = (Array.isArray(res) ? res : (res as unknown as { rows?: { ticker: string }[] }).rows) ?? [];
  return list.map((r) => String((r as { ticker: string }).ticker).toUpperCase());
}

async function ensureSnapshotTable() {
  await db.execute(sql.raw(`
    CREATE TABLE IF NOT EXISTS a318_segment0_fund_score_before (
      ticker text NOT NULL,
      fund_total numeric,
      as_of timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ticker)
    )
  `));
}

async function snapshotFundScores(tickers: string[]) {
  await ensureSnapshotTable();
  await db.execute(sql.raw(`TRUNCATE a318_segment0_fund_score_before`));
  if (tickers.length === 0) return 0;
  await db.execute(sql`
    INSERT INTO a318_segment0_fund_score_before (ticker, fund_total, as_of)
    SELECT UPPER(t.ticker), t.fund_total_score::numeric, now()
    FROM ticker_fundamentals t
    WHERE UPPER(t.ticker) IN (${sql.join(tickers.map((t) => sql`${t}`), sql`, `)})
  `);
  mkdirSync(OUT_DIR, { recursive: true });
  const csvRes = await db.execute(sql`
    SELECT ticker, fund_total::text FROM a318_segment0_fund_score_before ORDER BY ticker
  `);
  const csvRows = (Array.isArray(csvRes) ? csvRes : (csvRes as { rows?: unknown[] }).rows) ?? [];
  const lines = ["ticker,fund_total", ...csvRows.map((r: { ticker: string; fund_total: string }) => `${r.ticker},${r.fund_total ?? ""}`)];
  writeFileSync(join(OUT_DIR, "fund-score-before.csv"), lines.join("\n") + "\n");
  return tickers.length;
}

async function factsetGoldStats() {
  const res = await db.execute(sql`
    SELECT field, COUNT(*)::int AS n
    FROM field_provenance
    WHERE winning_source = 'factset' AND divergent = false
    GROUP BY field
    ORDER BY n DESC
  `);
  const rows = (Array.isArray(res) ? res : (res as { rows?: unknown[] }).rows) ?? [];
  const total = rows.reduce((s: number, r: { n: number }) => s + Number(r.n), 0);
  return { total, byField: rows as { field: string; n: number }[] };
}

async function scoredDivergentCount() {
  const res = await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM field_provenance fp
    INNER JOIN a318_segment0_fund_score_before s ON UPPER(fp.ticker) = s.ticker
    WHERE fp.divergent = true
  `);
  const rows = (Array.isArray(res) ? res : (res as unknown as { rows?: { n: number }[] }).rows) ?? [];
  return Number(rows[0]?.n ?? 0);
}

async function nonRulerFactsetGold(rulerSet: Set<string>) {
  const res = await db.execute(sql`
    SELECT field, COUNT(*)::int AS n
    FROM field_provenance
    WHERE winning_source = 'factset' AND divergent = false
    GROUP BY field
  `);
  const rows = (Array.isArray(res) ? res : (res as unknown as { rows?: { field: string; n: number }[] }).rows) ?? [];
  let total = 0;
  for (const r of rows) {
    if (!rulerSet.has(r.field)) total += Number(r.n);
  }
  return total;
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
    .map((d) => ({ ticker: d.ticker, delta: d.delta, field: "?" }));

  return { nChanged: deltas.length, medianAbs, movers: top10 };
}

async function main() {
  const reuseSnapshot = process.argv.includes("--reuse-snapshot");
  const tickers = await scoredBookTickers();
  console.error(`[a318-s0] scored book n=${tickers.length}`);

  if (!reuseSnapshot) {
    const nSnap = await snapshotFundScores(tickers);
    console.error(`[a318-s0] snapshot rows=${nSnap}`);
  } else {
    console.error("[a318-s0] --reuse-snapshot (keeping a318_segment0_fund_score_before)");
  }

  const beforeGold = await factsetGoldStats();

  const { execSync } = await import("node:child_process");
  execSync("pnpm exec tsx src/scripts/build-factset-ruler-table.ts", {
    cwd: join(dirname(fileURLToPath(import.meta.url)), "../.."),
    stdio: "inherit",
  });

  console.error("[a318-s0] merge-trusted…");
  await runMergeTrusted();
  const regime = await getLatestRegime();
  console.error(`[a318-s0] fund_score recompute regime=${regime ?? "null"}`);
  await computeAndPersistFundamentalScores(regime);

  const ruler = loadRulerTable();
  const rulerSet = new Set(ruler.rows.filter((r) => r.factsetRuler).map((r) => r.field));
  const afterGold = await factsetGoldStats();
  const nonRulerFs = await nonRulerFactsetGold(rulerSet);
  const scoredNr = await scoredDivergentCount();
  const delta = await scoreDelta();

  const packet = {
    rulerTable: ruler.rows.map((r) => ({
      field: r.field,
      n: r.n,
      inBandShare: r.inBandShare,
      ruler: r.factsetRuler ? "y" : "n",
    })),
    factsetGoldCells: { before: beforeGold.total, after: afterGold.total, nonRulerFactsetAfter: nonRulerFs },
    scoredBookDivergentAfter: scoredNr,
    fundScore: delta,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, "packet.json"), JSON.stringify(packet, null, 2) + "\n");
  console.log(JSON.stringify(packet));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
