/**
 * A85 — figure / macro-view tracker (Phase 1: registry + view records).
 * Scoring (Brier) is Phase 2 — only ~10 scored figures get badges later.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

export type FigureTier = 1 | 2 | 3 | 4;
export type ViewDirection = "bullish" | "bearish" | "neutral" | "hawkish" | "dovish";

export interface FigureDef {
  id: string;
  name: string;
  org: string;
  tier: FigureTier;
  /** Phase 2 Brier badges only for tier-1 scored set. */
  scored: boolean;
  channels: string;
}

/** Claude-narrowed scored set (~10) + a few display-only tiers. */
export const FIGURE_REGISTRY: FigureDef[] = [
  { id: "ptj", name: "Paul Tudor Jones", org: "Tudor", tier: 1, scored: true, channels: "CNBC rare; explicit probs" },
  { id: "tom-lee", name: "Tom Lee", org: "Fundstrat", tier: 1, scored: true, channels: "CNBC + Fundstrat YT + year-end SPX" },
  { id: "yardeni", name: "Ed Yardeni", org: "Yardeni Research", tier: 1, scored: true, channels: "explicit SPX targets" },
  { id: "amy-wu", name: "Amy Wu Silverman", org: "RBC", tier: 1, scored: true, channels: "CNBC Squawk — derivatives" },
  { id: "cabana", name: "Mark Cabana", org: "BofA", tier: 1, scored: true, channels: "rates path" },
  { id: "fed-powell", name: "Jerome Powell", org: "Fed", tier: 1, scored: true, channels: "FOMC / speeches" },
  { id: "fed-waller", name: "Christopher Waller", org: "Fed", tier: 1, scored: true, channels: "speeches / dots" },
  { id: "fed-bowman", name: "Michelle Bowman", org: "Fed", tier: 1, scored: true, channels: "speeches / dots" },
  { id: "treasury", name: "Treasury Secretary", org: "UST", tier: 1, scored: true, channels: "press / testimony" },
  { id: "rbc-desk", name: "RBC derivatives desk", org: "RBC", tier: 1, scored: true, channels: "desk commentary" },
  { id: "el-erian", name: "Mohamed El-Erian", org: "Allianz", tier: 2, scored: false, channels: "media / Substack" },
  { id: "siegel", name: "Jeremy Siegel", org: "Wharton", tier: 2, scored: false, channels: "media" },
  { id: "ives", name: "Dan Ives", org: "Wedbush", tier: 2, scored: false, channels: "CNBC / notes" },
  { id: "gundlach", name: "Jeff Gundlach", org: "DoubleLine", tier: 2, scored: false, channels: "webcasts" },
  { id: "druckenmiller", name: "Stanley Druckenmiller", org: "Duquesne", tier: 2, scored: false, channels: "rare interviews" },
];

let ensured = false;

async function ensure(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS figure_views (
      id bigserial PRIMARY KEY,
      figure_id text NOT NULL,
      as_of date NOT NULL,
      claim text NOT NULL,
      asset text,
      direction text,
      horizon text,
      confidence double precision,
      source_url text,
      resolved boolean NOT NULL DEFAULT false,
      outcome text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS figure_views_figure_asof_idx
    ON figure_views (figure_id, as_of DESC)`);
  ensured = true;
}

export interface FigureViewRow {
  id: number;
  figureId: string;
  asOf: string;
  claim: string;
  asset: string | null;
  direction: string | null;
  horizon: string | null;
  confidence: number | null;
  sourceUrl: string | null;
  resolved: boolean;
}

export async function listViews(limit = 40): Promise<FigureViewRow[]> {
  await ensure();
  return rowsOf<{
    id: number; figure_id: string; as_of: string; claim: string; asset: string | null;
    direction: string | null; horizon: string | null; confidence: number | null;
    source_url: string | null; resolved: boolean;
  }>((await db.execute(sql`
    SELECT id, figure_id, as_of::text, claim, asset, direction, horizon, confidence, source_url, resolved
    FROM figure_views ORDER BY as_of DESC, id DESC LIMIT ${limit}`)) as SqlRows<never>)
    .map((r) => ({
      id: Number(r.id),
      figureId: r.figure_id,
      asOf: r.as_of,
      claim: r.claim,
      asset: r.asset,
      direction: r.direction,
      horizon: r.horizon,
      confidence: r.confidence != null ? Number(r.confidence) : null,
      sourceUrl: r.source_url,
      resolved: Boolean(r.resolved),
    }));
}

export async function insertView(input: {
  figureId: string;
  asOf: string;
  claim: string;
  asset?: string | null;
  direction?: string | null;
  horizon?: string | null;
  confidence?: number | null;
  sourceUrl?: string | null;
}): Promise<number> {
  await ensure();
  if (!FIGURE_REGISTRY.some((f) => f.id === input.figureId)) {
    throw new Error(`unknown figure_id: ${input.figureId}`);
  }
  const rows = rowsOf<{ id: number }>((await db.execute(sql`
    INSERT INTO figure_views (figure_id, as_of, claim, asset, direction, horizon, confidence, source_url)
    VALUES (
      ${input.figureId}, ${input.asOf}::date, ${input.claim},
      ${input.asset ?? null}, ${input.direction ?? null}, ${input.horizon ?? null},
      ${input.confidence ?? null}, ${input.sourceUrl ?? null}
    ) RETURNING id`)) as SqlRows<never>);
  return Number(rows[0]?.id);
}

/** Latest view per figure + registry metadata for Voices panel. */
export async function getVoicesSummary(): Promise<Array<{
  figure: FigureDef;
  latest: FigureViewRow | null;
  openCount: number;
}>> {
  await ensure();
  const views = await listViews(200);
  const byFig = new Map<string, FigureViewRow[]>();
  for (const v of views) {
    const arr = byFig.get(v.figureId) ?? [];
    arr.push(v);
    byFig.set(v.figureId, arr);
  }
  return FIGURE_REGISTRY.map((figure) => {
    const list = byFig.get(figure.id) ?? [];
    return {
      figure,
      latest: list[0] ?? null,
      openCount: list.filter((v) => !v.resolved).length,
    };
  });
}
