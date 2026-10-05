/**
 * Daily tech_score_snapshots (A14) including real falling_knife.
 */
import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { db, tickerTechnicals, techScoreSnapshots, pool } from "@workspace/db";
import { scoreTechnicalRowV2 } from "./technical-scorer-v2.js";
import { getChampionScorecardParams } from "./scorecard-params.js";
import { logger } from "./logger.js";

function etDateKey(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

export async function ensureTechScoreSnapshotTables(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tech_score_snapshots (
      ticker text NOT NULL,
      as_of date NOT NULL,
      tech_total numeric,
      components jsonb NOT NULL DEFAULT '{}'::jsonb,
      coverage numeric,
      confidence text,
      falling_knife integer,
      peer_group_id text,
      model_version text,
      inputs_digest text,
      trigger text NOT NULL DEFAULT 'daily',
      computed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ticker, as_of)
    );
    CREATE INDEX IF NOT EXISTS idx_tech_score_snapshots_as_of ON tech_score_snapshots (as_of);
  `);
}

export async function persistTechScoreSnapshots(opts?: {
  asOf?: string;
  trigger?: string;
}): Promise<{ asOf: string; written: number; modelVersion: string }> {
  await ensureTechScoreSnapshotTables();
  const asOf = opts?.asOf ?? etDateKey();
  const trigger = opts?.trigger ?? "daily";
  const { version, params } = await getChampionScorecardParams("tech");

  const rows = await db.select().from(tickerTechnicals);
  const values = rows.map((r) => {
    const total = scoreTechnicalRowV2(r);
    const components = {
      rsi14: r.rsi14 != null ? Number(r.rsi14) : null,
      mfi14: r.mfi14 != null ? Number(r.mfi14) : null,
      stoch: r.stoch != null ? Number(r.stoch) : null,
      macdDirection: r.macdDirection,
      regime: r.regime,
      ivRank: r.ivRank != null ? Number(r.ivRank) : null,
      realizedVol20d: r.realizedVol20d != null ? Number(r.realizedVol20d) : null,
    };
    const present = Object.values(components).filter((v) => v != null && v !== "").length;
    const coverage = present / Object.keys(components).length;
    const digest = createHash("sha1")
      .update(JSON.stringify({ t: r.ticker, asOf, components, fk: r.fallingKnife }))
      .digest("hex")
      .slice(0, 16);
    return {
      ticker: r.ticker.toUpperCase(),
      asOf: asOf as unknown as string,
      techTotal: total != null ? String(total) : null,
      components,
      coverage: String(coverage),
      confidence: coverage >= 0.7 ? "high" : coverage >= 0.4 ? "low" : "insufficient",
      fallingKnife: r.fallingKnife ?? null,
      peerGroupId: null as string | null,
      modelVersion: version,
      inputsDigest: digest,
      trigger,
      computedAt: new Date(),
    };
  });

  let written = 0;
  for (let i = 0; i < values.length; i += 200) {
    const chunk = values.slice(i, i + 200);
    if (chunk.length === 0) continue;
    await db
      .insert(techScoreSnapshots)
      .values(chunk)
      .onConflictDoUpdate({
        target: [techScoreSnapshots.ticker, techScoreSnapshots.asOf],
        set: {
          techTotal: sql`excluded.tech_total`,
          components: sql`excluded.components`,
          coverage: sql`excluded.coverage`,
          confidence: sql`excluded.confidence`,
          fallingKnife: sql`excluded.falling_knife`,
          modelVersion: sql`excluded.model_version`,
          inputsDigest: sql`excluded.inputs_digest`,
          trigger: sql`excluded.trigger`,
          computedAt: sql`excluded.computed_at`,
        },
      });
    written += chunk.length;
  }

  logger.info({ asOf, written, modelVersion: version, paramsKeys: Object.keys(params) }, "tech_score_snapshots: persisted");
  return { asOf, written, modelVersion: version };
}
