/**
 * A94 — Conviction ledger (append-only, reason required; mirrors fv_assumptions style).
 * Scope: held / about-to-sell-put names. Kill rules are checkable JSON, not prose-only.
 */
import { pool } from "@workspace/db";

export type KillRule =
  | { kind: "metric"; field: string; op: ">" | "<" | ">=" | "<="; threshold: number }
  | { kind: "date"; by: string; label: string }
  | { kind: "price"; op: ">" | "<"; level: number };

let ensured = false;

export async function ensureConvictionTables(): Promise<void> {
  if (ensured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conviction_theses (
      id serial PRIMARY KEY,
      ticker text NOT NULL,
      claim text NOT NULL CHECK (length(claim) >= 5),
      horizon text NOT NULL DEFAULT 'medium',
      confidence int NOT NULL CHECK (confidence BETWEEN 1 AND 5),
      status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','killed','retired','proposed')),
      reason text NOT NULL CHECK (length(reason) >= 5),
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      reviewed_at timestamptz,
      killed_at timestamptz,
      kill_note text,
      supersedes int REFERENCES conviction_theses(id)
    );
    CREATE INDEX IF NOT EXISTS idx_conviction_theses_ticker
      ON conviction_theses (ticker, status);

    CREATE TABLE IF NOT EXISTS conviction_sub_theses (
      id serial PRIMARY KEY,
      thesis_id int NOT NULL REFERENCES conviction_theses(id) ON DELETE CASCADE,
      claim text NOT NULL CHECK (length(claim) >= 5),
      kill_rules jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'ok'
        CHECK (status IN ('ok','near','hit','retired')),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_conviction_sub_thesis
      ON conviction_sub_theses (thesis_id);

    CREATE TABLE IF NOT EXISTS conviction_evidence (
      id serial PRIMARY KEY,
      thesis_id int NOT NULL REFERENCES conviction_theses(id) ON DELETE CASCADE,
      sub_thesis_id int REFERENCES conviction_sub_theses(id) ON DELETE SET NULL,
      kind text NOT NULL,
      pointer jsonb NOT NULL DEFAULT '{}'::jsonb,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS conviction_events (
      id serial PRIMARY KEY,
      thesis_id int NOT NULL REFERENCES conviction_theses(id) ON DELETE CASCADE,
      event text NOT NULL,
      confidence int CHECK (confidence BETWEEN 1 AND 5),
      reason text NOT NULL CHECK (length(reason) >= 5),
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_conviction_events_thesis
      ON conviction_events (thesis_id, created_at);
  `);
  ensured = true;
}
