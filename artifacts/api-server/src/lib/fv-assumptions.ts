/**
 * Fair value assumptions: what each stock's value rests on, and every change to it (Claude, PM role, user 2026-10-14).
 *
 * Base fair value = shared rules for every stock (fv-* params in scorecard_params + the stock's peer group = its cohort), so names
 * stay comparable. Judgement lives only in the `fv_assumptions` ledger, never in place:
 *   - ticker scope: replace one input (FY1/FY2 EPS, long-term growth, revenue growth, FCF, beta) for one stock
 *   - peer_group scope: change an economic parameter (ERP, terminal growth, growth cap/floor) for one cohort
 * Each row needs a reason + source, has a status (proposed → active → retired | rejected) and an expiry (default: next
 * earnings), and is never edited — a change is a new row that supersedes the old one. Active rows produce a separate
 * "adjusted" fair value next to the base one (fair_value_snapshots.adjusted_fair_value + adjustments).
 * `fair_value_inputs` keeps every distinct input set per stock (price/momentum excluded) so "what changed and when" is answerable.
 */
import { createHash } from "crypto";
import { pool } from "@workspace/db";
import { computeFairValues, type FairValueParams, type FairValueResult, type FvMarket, type FvTickerInput } from "./fair-value.js";

export const INPUT_FIELDS = {
  forwardEps: { label: "FY1 EPS", unit: "usd", source: "LSEG FY1 consensus → IBES FY1 → vendor forward P/E (must agree with trailing EPS)" },
  eps2: { label: "FY2 EPS", unit: "usd", source: "IBES FY2 consensus (only when IBES is corroborated)" },
  ltg: { label: "Long-term growth", unit: "pct", source: "IBES long-term growth consensus" },
  revenueGrowth: { label: "Revenue growth YoY", unit: "pct", source: "Fundamentals gold (merge of FactSet / FMP / EDGAR / Yahoo)" },
  fcf: { label: "Free cash flow (levered)", unit: "usd_total", source: "Fundamentals gold: OCF − capex" },
  beta: { label: "Beta", unit: "x", source: "Fundamentals gold (Yahoo)" },
  trailingEps: { label: "Trailing EPS", unit: "usd", source: "Fundamentals gold" },
  shares: { label: "Shares outstanding", unit: "count", source: "Fundamentals gold" },
  ebitda: { label: "EBITDA", unit: "usd_total", source: "Fundamentals gold" },
  totalDebt: { label: "Total debt", unit: "usd_total", source: "Fundamentals gold" },
  cash: { label: "Cash", unit: "usd_total", source: "Fundamentals gold" },
  equity: { label: "Book equity", unit: "usd_total", source: "Fundamentals gold" },
  roe: { label: "ROE", unit: "pct", source: "Fundamentals gold" },
  analystTarget: { label: "Analyst target (mean)", unit: "usd", source: "LSEG consensus PT → vendor target" },
} as const;
export type InputField = keyof typeof INPUT_FIELDS;
/** Inputs a person may override for one stock (the rest are accounting facts). */
export const OVERRIDABLE_INPUTS: InputField[] = ["forwardEps", "eps2", "ltg", "revenueGrowth", "fcf", "beta"];
/** Economic parameters a cohort (peer group) may override; everything else stays global. */
export const COHORT_PARAMS = ["equityRiskPremium", "terminalGrowth", "growthCap", "growthFloor"] as const;
export type CohortParam = (typeof COHORT_PARAMS)[number];

export interface AssumptionRow {
  id: number; scope: "ticker" | "peer_group"; scope_key: string; field: string; value: number; reason: string; source: string | null;
  status: "proposed" | "active" | "retired" | "rejected"; created_by: string | null; created_at: string; decided_by: string | null;
  decided_at: string | null; decision_note: string | null; expires_at: string | null; supersedes: number | null;
}

let ensured = false;
export async function ensureAssumptionTables(): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS fair_value_inputs (
      ticker text NOT NULL, digest text NOT NULL, inputs jsonb NOT NULL, first_seen date NOT NULL,
      PRIMARY KEY (ticker, digest));
    CREATE INDEX IF NOT EXISTS idx_fair_value_inputs_ticker ON fair_value_inputs (ticker, first_seen);
    CREATE TABLE IF NOT EXISTS fv_assumptions (
      id serial PRIMARY KEY, scope text NOT NULL CHECK (scope IN ('ticker','peer_group')), scope_key text NOT NULL,
      field text NOT NULL, value double precision NOT NULL, reason text NOT NULL CHECK (length(reason) >= 5), source text,
      status text NOT NULL CHECK (status IN ('proposed','active','retired','rejected')), created_by text,
      created_at timestamptz NOT NULL DEFAULT now(), decided_by text, decided_at timestamptz, decision_note text,
      expires_at date, supersedes int REFERENCES fv_assumptions(id));
    CREATE INDEX IF NOT EXISTS idx_fv_assumptions_scope ON fv_assumptions (scope, scope_key, status);
    ALTER TABLE fair_value_snapshots ADD COLUMN IF NOT EXISTS adjusted_fair_value numeric;
    ALTER TABLE fair_value_snapshots ADD COLUMN IF NOT EXISTS adjustments jsonb;
  `);
  ensured = true;
}

function assumptionInputs(t: FvTickerInput): Record<string, unknown> {
  const { price: _p, momentum12_1: _m, ...rest } = t;
  return rest;
}

/** Store each stock's input set when it differs from every stored one (price/momentum excluded → ~1 row per real change). */
export async function recordInputs(inputs: FvTickerInput[], asOf: string): Promise<void> {
  await ensureAssumptionTables();
  const rows = inputs.map((t) => {
    const body = assumptionInputs(t);
    return [t.ticker, createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 16), JSON.stringify(body), asOf];
  });
  const CHUNK = 400;
  for (let s = 0; s < rows.length; s += CHUNK) {
    const part = rows.slice(s, s + CHUNK);
    await pool.query(
      `INSERT INTO fair_value_inputs (ticker, digest, inputs, first_seen) VALUES
       ${part.map((_, i) => `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3}::jsonb,$${i * 4 + 4}::date)`).join(",")}
       ON CONFLICT (ticker, digest) DO NOTHING`,
      part.flat(),
    );
  }
}

export async function activeAssumptions(asOf: string): Promise<AssumptionRow[]> {
  await ensureAssumptionTables();
  const { rows } = await pool.query(
    `SELECT * FROM fv_assumptions WHERE status = 'active' AND (expires_at IS NULL OR expires_at >= $1::date) ORDER BY id`, [asOf]);
  return rows as AssumptionRow[];
}

/**
 * Adjusted fair values for every stock touched by an active assumption. Peer statistics come from the same input list, with
 * only the overridden stocks' inputs changed, so the cohort comparison stays like-for-like.
 */
export function computeAdjusted(
  inputs: FvTickerInput[], market: FvMarket, params: FairValueParams, active: AssumptionRow[],
): Map<string, { result: FairValueResult; applied: { id: number; field: string; value: number; scope: string }[] }> {
  const out = new Map<string, { result: FairValueResult; applied: { id: number; field: string; value: number; scope: string }[] }>();
  if (active.length === 0) return out;
  const tickerRows = active.filter((a) => a.scope === "ticker" && (OVERRIDABLE_INPUTS as string[]).includes(a.field));
  const groupRows = active.filter((a) => a.scope === "peer_group" && (COHORT_PARAMS as readonly string[]).includes(a.field));
  const byTicker = new Map<string, AssumptionRow[]>();
  for (const a of tickerRows) byTicker.set(a.scope_key, [...(byTicker.get(a.scope_key) ?? []), a]);
  const adjInputs = inputs.map((t) => {
    const rows = byTicker.get(t.ticker);
    if (!rows) return t;
    const copy = { ...t } as Record<string, unknown>;
    for (const a of rows) copy[a.field] = a.value; // later id wins (ordered by id)
    return copy as unknown as FvTickerInput;
  });
  const groups = new Map<string, AssumptionRow[]>();
  for (const a of groupRows) groups.set(a.scope_key, [...(groups.get(a.scope_key) ?? []), a]);
  // one pass with global params for ticker overrides outside overridden cohorts, one pass per overridden cohort
  const passes: { params: FairValueParams; tickers: Set<string>; cohort: AssumptionRow[] }[] = [];
  const cohortTickers = new Set<string>();
  for (const [gid, rows] of groups) {
    const p = { ...params } as Record<string, unknown>;
    for (const a of rows) p[a.field] = a.value;
    const members = new Set(inputs.filter((t) => t.peerGroupId === gid).map((t) => t.ticker));
    members.forEach((m) => cohortTickers.add(m));
    passes.push({ params: p as unknown as FairValueParams, tickers: members, cohort: rows });
  }
  const loose = new Set([...byTicker.keys()].filter((t) => !cohortTickers.has(t)));
  if (loose.size) passes.push({ params, tickers: loose, cohort: [] });
  for (const pass of passes) {
    for (const r of computeFairValues(adjInputs, market, pass.params)) {
      if (!pass.tickers.has(r.ticker)) continue;
      const applied = [...(byTicker.get(r.ticker) ?? []), ...pass.cohort].map((a) => ({ id: a.id, field: a.field, value: a.value, scope: a.scope }));
      out.set(r.ticker, { result: r, applied });
    }
  }
  return out;
}
