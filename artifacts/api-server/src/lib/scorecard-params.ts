/**
 * Versioned base-scorecard parameters (A17/A18).
 * Cursor-owned public.scorecard_params — not watchlist_sync.model_params.
 * Engines read the champion for a lane; code SEED is the boot fallback.
 *
 * Seeds are duplicated from engine constants (no circular imports).
 */
import { and, eq } from "drizzle-orm";
import { db, scorecardParams, pool } from "@workspace/db";
import { FAIR_VALUE_SEED } from "./fair-value.js";

export type ScorecardLane = "fund" | "tech" | "options" | "fair_value";

/** Mirrors fund-score-engine METRICS baseIntra + family weights at fund-1.0.0. */
const FUND_SEED: Record<string, unknown> = {
  metricBaseIntra: {
    earningsYield: 3, fcfYield: 3, ps: 1.5, peg: 2, fwdpe: 2, evEbitda: 2, evRev: 1,
    pb: 1, ptbv: 2, pFfo: 2.5, expEy: 3.5, divy: 1,
    revgrow: 2.5, revaccel: 2, epsgrow: 2.5, upside: 1, avgEpsSurprise: 1,
    ibesRevBreadth: 1.5, ibesSue: 1, ibesFwdGrowth: 0,
    grossmgn: 2, operatingmgn: 2.25, netmgn: 3.25, roe: 2, fcfmgn: 2.25,
    roicwacc: 1.5, gpa: 2, accruals: 2, fScore: 2,
    cashrun: 3, intcov: 2.5, dilution: 2, cr: 1.5, de: 1, netDebtEbitda: 2,
    beta: 1.5, netCashAssets: 2,
  },
  styleFamilyWeights: {
    value: { value: 35, growth: 15, quality: 30, safety: 20 },
    growth: { value: 14, growth: 35, quality: 33, safety: 18 },
    garp: { value: 25, growth: 28, quality: 32, safety: 15 },
    blend: { value: 25, growth: 25, quality: 30, safety: 20 },
    quality_defensive: { value: 15, growth: 15, quality: 40, safety: 30 },
    pre_revenue: { value: 5, growth: 40, quality: 25, safety: 30 },
    financial: { value: 25, growth: 15, quality: 30, safety: 30 },
  },
  megacapBlendFamilyWeights: { value: 15, growth: 20, quality: 40, safety: 25 },
  totalMinCoverage: 0.4,
  familyMinCoverage: 0.5,
};

const TECH_SEED: Record<string, unknown> = {
  weights: {
    oversoldDepth: 0.25,
    reversalSignal: 0.20,
    volatilityState: 0.22,
    trendContext: 0.18,
    optionsFlow: 0.10,
    volumeConfirm: 0.05,
  },
};

const OPTIONS_SEED: Record<string, unknown> = {
  strikeWeights: {
    income: 0.30,
    buffer: 0.32,
    ivRelative: 0.10,
    ivAbsolute: 0.06,
    stockQuality: 0.12,
    support: 0.06,
    dte: 0.04,
  },
  incomeFloor: 0.5,
  incomeTarget: 1.0,
  callIncomeFloor: 0.35,
  callIncomeTarget: 0.65,
};

export const SCORECARD_SEEDS: Record<ScorecardLane, { version: string; params: Record<string, unknown> }> = {
  fund: { version: "fund-1.0.0", params: FUND_SEED },
  tech: { version: "tech-1.0.0", params: TECH_SEED },
  options: { version: "options-1.0.0", params: OPTIONS_SEED },
  fair_value: { version: "fv-1.0.0", params: FAIR_VALUE_SEED as unknown as Record<string, unknown> },
};

let ensured = false;

export async function ensureScorecardParamsTables(): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scorecard_params (
      version text PRIMARY KEY,
      lane text NOT NULL,
      status text NOT NULL,
      parent text,
      params jsonb NOT NULL,
      rationale jsonb,
      evidence jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      promoted_at timestamptz,
      approved_by text
    );
    CREATE UNIQUE INDEX IF NOT EXISTS scorecard_params_one_champion_per_lane
      ON scorecard_params (lane) WHERE status = 'champion';
    CREATE INDEX IF NOT EXISTS idx_scorecard_params_lane_status
      ON scorecard_params (lane, status);
  `);
  for (const lane of Object.keys(SCORECARD_SEEDS) as ScorecardLane[]) {
    const seed = SCORECARD_SEEDS[lane]!;
    const existing = await pool.query(
      `SELECT 1 FROM scorecard_params WHERE lane = $1 AND status = 'champion' LIMIT 1`,
      [lane],
    );
    if ((existing.rowCount ?? 0) === 0) {
      await pool.query(
        `INSERT INTO scorecard_params (version, lane, status, params, rationale, promoted_at, approved_by)
         VALUES ($1, $2, 'champion', $3::jsonb, $4::jsonb, now(), 'user')
         ON CONFLICT (version) DO NOTHING`,
        [
          seed.version,
          lane,
          JSON.stringify(seed.params),
          JSON.stringify([{ why: `seed ${seed.version} from code constants (A18)` }]),
        ],
      );
    }
  }
  ensured = true;
}

export async function getChampionScorecardParams(
  lane: ScorecardLane,
): Promise<{ version: string; params: Record<string, unknown>; parent: string | null }> {
  await ensureScorecardParamsTables();
  try {
    const [row] = await db
      .select({
        version: scorecardParams.version,
        params: scorecardParams.params,
        parent: scorecardParams.parent,
      })
      .from(scorecardParams)
      .where(and(eq(scorecardParams.lane, lane), eq(scorecardParams.status, "champion")))
      .limit(1);
    if (row?.params && typeof row.params === "object") {
      const seed = SCORECARD_SEEDS[lane]!.params;
      return {
        version: row.version,
        params: deepMerge(seed, row.params as Record<string, unknown>),
        parent: row.parent ?? null,
      };
    }
  } catch {
    /* fall through to seed */
  }
  const seed = SCORECARD_SEEDS[lane]!;
  return { version: seed.version, params: seed.params, parent: null };
}

/** Load a specific scorecard version (A172 shadow parent). Merges lane seed when known. */
export async function getScorecardParamsByVersion(
  version: string,
): Promise<{ version: string; params: Record<string, unknown>; lane: ScorecardLane } | null> {
  await ensureScorecardParamsTables();
  try {
    const [row] = await db
      .select({
        version: scorecardParams.version,
        params: scorecardParams.params,
        lane: scorecardParams.lane,
      })
      .from(scorecardParams)
      .where(eq(scorecardParams.version, version))
      .limit(1);
    if (!row?.params || typeof row.params !== "object") return null;
    const lane = row.lane as ScorecardLane;
    const seed = SCORECARD_SEEDS[lane]?.params ?? {};
    return {
      version: row.version,
      lane,
      params: deepMerge(seed, row.params as Record<string, unknown>),
    };
  } catch {
    return null;
  }
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object" && out[k] && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}
