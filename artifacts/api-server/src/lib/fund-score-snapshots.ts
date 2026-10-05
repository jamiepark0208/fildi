/**
 * Fund score history: daily snapshots + auto-attribution for Breakdown charts.
 */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db, fundScoreSnapshots, fundScoreNotes, type FundScoreSnapshot } from "@workspace/db";
import { logger } from "./logger.js";

export type ScoreTrigger = "nightly" | "admin_recompute" | "peer_override" | "manual_refresh";

export type TopMetric = {
  key: string;
  family: string;
  raw: number | null;
  peerPct: number | null;
  contrib: number;
};

export type SnapshotInput = {
  ticker: string;
  fundTotal: number | null;
  fundValue: number | null;
  fundGrowth: number | null;
  fundQuality: number | null;
  fundSafety: number | null;
  styleBucket: string | null;
  coverage: number | null;
  confidence: string | null;
  peerGroupId: string | null;
  topMetrics: TopMetric[];
  trigger: ScoreTrigger;
  asOf?: Date;
  modelVersion?: string | null;
  inputsDigest?: string | null;
};

function etDateKey(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export function pickTopMetrics(
  metricScores: Record<string, { value?: number | null; peerNorm?: number | null; weightedScore?: number }>,
  familyByKey: Record<string, string>,
  n = 8,
): TopMetric[] {
  return Object.entries(metricScores)
    .map(([key, v]) => ({
      key,
      family: familyByKey[key] ?? "unknown",
      raw: v.value ?? null,
      peerPct: v.peerNorm != null ? Math.round(v.peerNorm * 100) : null,
      contrib: v.weightedScore ?? 0,
    }))
    .filter((m) => m.contrib !== 0 || m.raw != null)
    .sort((a, b) => Math.abs(b.contrib) - Math.abs(a.contrib))
    .slice(0, n);
}

let tablesReady: Promise<void> | null = null;
function ensureTablesOnce(): Promise<void> {
  if (!tablesReady) tablesReady = ensureFundScoreAccountabilityTables().catch((err) => {
    tablesReady = null;
    throw err;
  });
  return tablesReady;
}

export async function upsertFundScoreSnapshots(rows: SnapshotInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  await ensureTablesOnce();
  const asOfDefault = etDateKey();
  const values = rows.map((r) => ({
    ticker: r.ticker.toUpperCase(),
    asOf: (r.asOf ? etDateKey(r.asOf) : asOfDefault) as unknown as string,
    fundTotal: r.fundTotal != null ? String(r.fundTotal) : null,
    fundValue: r.fundValue != null ? String(r.fundValue) : null,
    fundGrowth: r.fundGrowth != null ? String(r.fundGrowth) : null,
    fundQuality: r.fundQuality != null ? String(r.fundQuality) : null,
    fundSafety: r.fundSafety != null ? String(r.fundSafety) : null,
    styleBucket: r.styleBucket,
    coverage: r.coverage != null ? String(r.coverage) : null,
    confidence: r.confidence,
    peerGroupId: r.peerGroupId,
    trigger: r.trigger,
    topMetrics: r.topMetrics,
    modelVersion: r.modelVersion ?? null,
    inputsDigest: r.inputsDigest ?? null,
    computedAt: new Date(),
  }));

  // Batch upsert in chunks of 200
  let written = 0;
  for (let i = 0; i < values.length; i += 200) {
    const chunk = values.slice(i, i + 200);
    await db
      .insert(fundScoreSnapshots)
      .values(chunk)
      .onConflictDoUpdate({
        target: [fundScoreSnapshots.ticker, fundScoreSnapshots.asOf],
        set: {
          fundTotal: sql`excluded.fund_total`,
          fundValue: sql`excluded.fund_value`,
          fundGrowth: sql`excluded.fund_growth`,
          fundQuality: sql`excluded.fund_quality`,
          fundSafety: sql`excluded.fund_safety`,
          styleBucket: sql`excluded.style_bucket`,
          coverage: sql`excluded.coverage`,
          confidence: sql`excluded.confidence`,
          peerGroupId: sql`excluded.peer_group_id`,
          trigger: sql`excluded.trigger`,
          topMetrics: sql`excluded.top_metrics`,
          modelVersion: sql`excluded.model_version`,
          inputsDigest: sql`excluded.inputs_digest`,
          computedAt: sql`excluded.computed_at`,
        },
      });
    written += chunk.length;
  }
  return written;
}

function num(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export type HistoryPoint = {
  asOf: string;
  fundTotal: number | null;
  fundValue: number | null;
  fundGrowth: number | null;
  fundQuality: number | null;
  fundSafety: number | null;
  styleBucket: string | null;
  confidence: string | null;
  trigger: string;
  deltaTotal: number | null;
  largeMove: boolean;
  attribution: string[];
  notes: Array<{ id: number; body: string; author: string | null; tags: string[]; adjPoints: number | null }>;
};

const LARGE_MOVE_TOTAL = 5;
const LARGE_MOVE_FAMILY = 8;

function attributionBetween(prev: FundScoreSnapshot | null, cur: FundScoreSnapshot): string[] {
  if (!prev) return [];
  const bullets: string[] = [];
  const dt = (num(cur.fundTotal) ?? 0) - (num(prev.fundTotal) ?? 0);
  if (Math.abs(dt) >= LARGE_MOVE_TOTAL) {
    bullets.push(`Total ${dt >= 0 ? "+" : ""}${dt.toFixed(1)}`);
  }
  const fams: Array<[string, number | null, number | null]> = [
    ["Value", num(cur.fundValue), num(prev.fundValue)],
    ["Growth", num(cur.fundGrowth), num(prev.fundGrowth)],
    ["Quality", num(cur.fundQuality), num(prev.fundQuality)],
    ["Safety", num(cur.fundSafety), num(prev.fundSafety)],
  ];
  for (const [name, a, b] of fams) {
    if (a == null || b == null) continue;
    const d = a - b;
    if (Math.abs(d) >= LARGE_MOVE_FAMILY) bullets.push(`${name} ${d >= 0 ? "+" : ""}${d.toFixed(1)}`);
  }

  const prevTop = (Array.isArray(prev.topMetrics) ? prev.topMetrics : []) as TopMetric[];
  const curTop = (Array.isArray(cur.topMetrics) ? cur.topMetrics : []) as TopMetric[];
  const prevMap = new Map(prevTop.map((m) => [m.key, m.contrib]));
  const deltas = curTop
    .map((m) => ({ key: m.key, family: m.family, d: m.contrib - (prevMap.get(m.key) ?? 0), peerPct: m.peerPct }))
    .filter((m) => Math.abs(m.d) >= 0.02)
    .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
    .slice(0, 3);
  for (const m of deltas) {
    const pct = m.peerPct != null ? ` (p${m.peerPct})` : "";
    bullets.push(`${m.key}${pct} contrib ${m.d >= 0 ? "+" : ""}${m.d.toFixed(2)}`);
  }
  if (prev.styleBucket && cur.styleBucket && prev.styleBucket !== cur.styleBucket) {
    bullets.push(`Style ${prev.styleBucket} → ${cur.styleBucket}`);
  }
  return bullets.slice(0, 6);
}

export async function readFundScoreHistory(
  ticker: string,
  opts?: { days?: number },
): Promise<HistoryPoint[]> {
  await ensureTablesOnce();
  const key = ticker.toUpperCase();
  const days = opts?.days ?? 365;
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceKey = etDateKey(since);

  const [snaps, notes] = await Promise.all([
    db
      .select()
      .from(fundScoreSnapshots)
      .where(and(eq(fundScoreSnapshots.ticker, key), gte(fundScoreSnapshots.asOf, sinceKey as unknown as string)))
      .orderBy(fundScoreSnapshots.asOf),
    db
      .select()
      .from(fundScoreNotes)
      .where(and(eq(fundScoreNotes.ticker, key), gte(fundScoreNotes.asOf, sinceKey as unknown as string)))
      .orderBy(desc(fundScoreNotes.createdAt)),
  ]);

  const notesByDay = new Map<string, typeof notes>();
  for (const n of notes) {
    const d = String(n.asOf).slice(0, 10);
    const list = notesByDay.get(d) ?? [];
    list.push(n);
    notesByDay.set(d, list);
  }

  const points: HistoryPoint[] = [];
  for (let i = 0; i < snaps.length; i++) {
    const cur = snaps[i]!;
    const prev = i > 0 ? snaps[i - 1]! : null;
    const total = num(cur.fundTotal);
    const prevTotal = prev ? num(prev.fundTotal) : null;
    const deltaTotal = total != null && prevTotal != null ? total - prevTotal : null;
    const attr = attributionBetween(prev, cur);
    const largeMove =
      (deltaTotal != null && Math.abs(deltaTotal) >= LARGE_MOVE_TOTAL) || attr.some((a) => /^(Value|Growth|Quality|Safety)/.test(a));
    const day = String(cur.asOf).slice(0, 10);
    const dayNotes = (notesByDay.get(day) ?? []).map((n) => ({
      id: n.id,
      body: n.body,
      author: n.author,
      tags: (Array.isArray(n.tags) ? n.tags : []) as string[],
      adjPoints: num(n.adjPoints),
    }));
    points.push({
      asOf: day,
      fundTotal: total,
      fundValue: num(cur.fundValue),
      fundGrowth: num(cur.fundGrowth),
      fundQuality: num(cur.fundQuality),
      fundSafety: num(cur.fundSafety),
      styleBucket: cur.styleBucket,
      confidence: cur.confidence,
      trigger: cur.trigger,
      deltaTotal,
      largeMove,
      attribution: attr,
      notes: dayNotes,
    });
  }
  return points;
}

export async function activeAdjPoints(ticker: string): Promise<number> {
  await ensureTablesOnce();
  const key = ticker.toUpperCase();
  const now = new Date();
  const rows = await db
    .select({ adjPoints: fundScoreNotes.adjPoints, expiresAt: fundScoreNotes.expiresAt })
    .from(fundScoreNotes)
    .where(eq(fundScoreNotes.ticker, key));
  let sum = 0;
  for (const r of rows) {
    const adj = num(r.adjPoints);
    if (adj == null) continue;
    if (r.expiresAt && r.expiresAt.getTime() < now.getTime()) continue;
    sum += adj;
  }
  return sum;
}

export async function ensureFundScoreAccountabilityTables(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "fund_score_snapshots" (
      "ticker" text NOT NULL,
      "as_of" date NOT NULL,
      "fund_total" numeric,
      "fund_value" numeric,
      "fund_growth" numeric,
      "fund_quality" numeric,
      "fund_safety" numeric,
      "style_bucket" text,
      "coverage" numeric,
      "confidence" text,
      "peer_group_id" text,
      "trigger" text NOT NULL DEFAULT 'nightly',
      "top_metrics" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "model_version" text,
      "inputs_digest" text,
      "computed_at" timestamp with time zone NOT NULL DEFAULT now(),
      PRIMARY KEY ("ticker", "as_of")
    )
  `);
  await db.execute(sql`ALTER TABLE fund_score_snapshots ADD COLUMN IF NOT EXISTS model_version text`);
  await db.execute(sql`ALTER TABLE fund_score_snapshots ADD COLUMN IF NOT EXISTS inputs_digest text`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "idx_fund_score_snapshots_ticker_as_of"
    ON "fund_score_snapshots" ("ticker", "as_of")
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "fund_score_notes" (
      "id" serial PRIMARY KEY,
      "ticker" text NOT NULL,
      "as_of" date NOT NULL,
      "body" text NOT NULL,
      "author" text,
      "tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "adj_points" numeric,
      "expires_at" timestamp with time zone,
      "linked_snapshot_as_of" date,
      "created_at" timestamp with time zone NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "idx_fund_score_notes_ticker_as_of"
    ON "fund_score_notes" ("ticker", "as_of")
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "idx_fund_score_notes_ticker_created"
    ON "fund_score_notes" ("ticker", "created_at")
  `);
  logger.info("fund_score_snapshots + fund_score_notes tables ensured");
}
