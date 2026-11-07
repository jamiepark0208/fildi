/**
 * A367 — shared fetch guard contract (TypeScript jobs). Mirror of scripts/fetch_guard.py.
 */
import { lastCompletedSessionYmd, isTradingDayYmd } from "./market-hours.js";

export type FetchMode = "skip" | "tail" | "backfill";
export type Cadence = "daily" | "weekly" | "monthly";

export type KeyPlan = {
  key: string;
  mode: FetchMode;
  watermark: string | null;
  tailFrom: string | null;
  tailTo: string | null;
};

export function expectedSessionYmd(cadence: Cadence = "daily", now = new Date()): string {
  const ymd = lastCompletedSessionYmd(now);
  if (cadence === "daily") return ymd;
  let d = new Date(`${ymd}T12:00:00Z`);
  for (let i = 0; i < 7; i++) {
    const k = d.toISOString().slice(0, 10);
    if (isTradingDayYmd(k)) return k;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return ymd;
}

function addCalendarDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function planKey(
  key: string,
  watermark: string | null,
  opts?: {
    cadence?: Cadence;
    overlapDays?: number;
    allowBackfill?: boolean;
    now?: Date;
  },
): KeyPlan {
  const cadence = opts?.cadence ?? "daily";
  const overlap = opts?.overlapDays ?? 2;
  const expected = expectedSessionYmd(cadence, opts?.now);
  if (!watermark) {
    if (opts?.allowBackfill) {
      return { key, mode: "backfill", watermark: null, tailFrom: null, tailTo: expected };
    }
    return { key, mode: "skip", watermark: null, tailFrom: null, tailTo: null };
  }
  if (watermark >= expected) {
    return { key, mode: "skip", watermark, tailFrom: null, tailTo: null };
  }
  const tailFrom = addCalendarDays(watermark, -(overlap - 1));
  return { key, mode: "tail", watermark, tailFrom, tailTo: expected };
}

export async function watermarksForKeys(
  table: string,
  dateCol: string,
  keyCol: string,
  keys: string[],
): Promise<Map<string, string>> {
  const { pool } = await import("@workspace/db");
  if (!keys.length) return new Map();
  const [schema, rel] = table.split(".");
  const { rows } = await pool.query<{ k: string; wm: string }>(
    `SELECT ${keyCol} AS k, MAX(${dateCol})::text AS wm
     FROM ${schema}.${rel}
     WHERE ${keyCol} = ANY($1::text[])
     GROUP BY 1`,
    [keys],
  );
  return new Map(rows.map((r) => [r.k, r.wm.slice(0, 10)]));
}

/** Raw-sql upsert suffix: only touch rows whose value columns changed. */
export function distinctConflictWhere(cols: string[], alias = "t"): string {
  const left = cols.map((c) => `${alias}.${c}`).join(", ");
  const right = cols.map((c) => `EXCLUDED.${c}`).join(", ");
  return `WHERE (${left}) IS DISTINCT FROM (${right})`;
}

export type FetchRunHandle = {
  id: number;
  vendorCalls: number;
  rowsInserted: number;
  rowsChanged: number;
  keysPlanned: number;
  keysSkipped: number;
  keysFetched: number;
  bump(c: Partial<{
    vendorCalls: number;
    rowsInserted: number;
    rowsChanged: number;
    keysPlanned: number;
    keysSkipped: number;
    keysFetched: number;
  }>): void;
  finish(mode: string): Promise<void>;
};

export async function startFetchRun(
  source: string,
  job: string,
  meta?: Record<string, unknown>,
): Promise<FetchRunHandle> {
  const { pool } = await import("@workspace/db");
  const t0 = Date.now();
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO fetch_runs (source, job, meta)
     VALUES ($1, $2, $3::jsonb) RETURNING id`,
    [source, job, JSON.stringify(meta ?? {})],
  );
  const id = rows[0]!.id;
  let vendorCalls = 0;
  let rowsInserted = 0;
  let rowsChanged = 0;
  let keysPlanned = 0;
  let keysSkipped = 0;
  let keysFetched = 0;
  return {
    id,
    get vendorCalls() {
      return vendorCalls;
    },
    get rowsInserted() {
      return rowsInserted;
    },
    get rowsChanged() {
      return rowsChanged;
    },
    get keysPlanned() {
      return keysPlanned;
    },
    get keysSkipped() {
      return keysSkipped;
    },
    get keysFetched() {
      return keysFetched;
    },
    bump(c) {
      vendorCalls += c.vendorCalls ?? 0;
      rowsInserted += c.rowsInserted ?? 0;
      rowsChanged += c.rowsChanged ?? 0;
      keysPlanned += c.keysPlanned ?? 0;
      keysSkipped += c.keysSkipped ?? 0;
      keysFetched += c.keysFetched ?? 0;
    },
    async finish(mode: string) {
      const seconds = (Date.now() - t0) / 1000;
      await pool.query(
        `UPDATE fetch_runs SET finished_at = now(), mode = $2,
           keys_planned = $3, keys_skipped = $4, keys_fetched = $5,
           vendor_calls = $6, rows_inserted = $7, rows_changed = $8, seconds = $9
         WHERE id = $1`,
        [id, mode, keysPlanned, keysSkipped, keysFetched, vendorCalls, rowsInserted, rowsChanged, seconds],
      );
    },
  };
}
