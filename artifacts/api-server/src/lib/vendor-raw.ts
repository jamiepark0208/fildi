/**
 * A266 — keep the vendor JSON we already fetched.
 * New row only when payload_sha changes; otherwise fetched_on moves forward.
 * EDGAR companyfacts: one row per key (latestOnly). Retention 400 days.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { etDateKey } from "./market-hours.js";
import { logger } from "./logger.js";

async function dbHandle() {
  const { db, pool, sourceFundamentals } = await import("@workspace/db");
  return { db, pool, sourceFundamentals };
}
import {
  decideVendorRawAction,
  type VendorRawIdentity,
} from "./dropped-vendor-fields.js";

const RETENTION_DAYS = 400;

const GOLD_COLUMNS: Array<[string, string]> = [
  ["peg_ttm", "pegTtm"],
  ["eps_growth_5y", "epsGrowth5Y"],
  ["revenue_growth_5y", "revenueGrowth5Y"],
  ["payout_ratio", "payoutRatio"],
  ["interest_coverage", "interestCoverage"],
  ["price_to_fcf", "priceToFcf"],
  ["fcf_yield", "fcfYield"],
  ["sbc_to_revenue", "sbcToRevenue"],
  ["income_quality", "incomeQuality"],
  ["price_to_tbv", "priceToTbv"],
  ["tier1_capital_ratio", "tier1CapitalRatio"],
  ["total_capital_ratio", "totalCapitalRatio"],
  ["rotce", "rotce"],
  ["net_interest_income", "netInterestIncome"],
  ["total_deposits", "totalDeposits"],
];

let ensured: Promise<void> | null = null;

export function ensureVendorRawSchema(): Promise<void> {
  if (!ensured) {
    ensured = (async () => {
      const { pool } = await dbHandle();
      await pool.query(`
        CREATE TABLE IF NOT EXISTS vendor_raw (
          source text NOT NULL,
          endpoint text NOT NULL,
          key text NOT NULL,
          fetched_on date NOT NULL,
          payload jsonb NOT NULL,
          payload_sha text NOT NULL,
          PRIMARY KEY (source, endpoint, key, fetched_on)
        )`);
      for (const [col] of GOLD_COLUMNS) {
        await pool.query(
          `ALTER TABLE ticker_fundamentals ADD COLUMN IF NOT EXISTS ${col} numeric`,
        );
      }
    })().catch((err) => {
      ensured = null;
      throw err;
    });
  }
  return ensured;
}

export async function rememberVendorPayload(
  id: VendorRawIdentity & { payload: unknown },
): Promise<"insert" | "touch" | "replace" | "noop"> {
  if (id.payload == null) return "noop";
  await ensureVendorRawSchema();
  const { pool } = await dbHandle();
  const sha = createHash("sha256").update(JSON.stringify(id.payload)).digest("hex");
  const today = etDateKey();
  const latest = await pool.query<{ fetched_on: string; payload_sha: string }>(
    `SELECT fetched_on::text AS fetched_on, payload_sha
     FROM vendor_raw
     WHERE source = $1 AND endpoint = $2 AND key = $3
     ORDER BY fetched_on DESC
     LIMIT 1`,
    [id.source, id.endpoint, id.key],
  );
  const row = latest.rows[0]
    ? { fetchedOn: String(latest.rows[0].fetched_on).slice(0, 10), payloadSha: latest.rows[0].payload_sha }
    : null;
  const decision = decideVendorRawAction(row, today, sha, !!id.latestOnly);
  if (decision.op === "noop" && !id.latestOnly) return "noop";
  if (id.latestOnly) {
    await pool.query(
      `DELETE FROM vendor_raw
       WHERE source = $1 AND endpoint = $2 AND key = $3 AND fetched_on <> $4::date`,
      [id.source, id.endpoint, id.key, today],
    );
    if (decision.op === "noop") return "noop";
  }
  if (decision.op === "touch") {
    await pool.query(
      `UPDATE vendor_raw SET fetched_on = $4::date
       WHERE source = $1 AND endpoint = $2 AND key = $3 AND fetched_on = $5::date`,
      [id.source, id.endpoint, id.key, today, decision.fromDate],
    );
    return "touch";
  }
  await pool.query(
    `INSERT INTO vendor_raw (source, endpoint, key, fetched_on, payload, payload_sha)
     VALUES ($1, $2, $3, $4::date, $5::jsonb, $6)
     ON CONFLICT (source, endpoint, key, fetched_on)
     DO UPDATE SET payload = EXCLUDED.payload, payload_sha = EXCLUDED.payload_sha`,
    [id.source, id.endpoint, id.key, today, JSON.stringify(id.payload), sha],
  );
  return decision.op === "replace" ? "replace" : "insert";
}

export async function rememberYahooQuoteSummary(
  ticker: string,
  modules: string,
  payload: unknown,
): Promise<void> {
  try {
    await rememberVendorPayload({
      source: "yahoo",
      endpoint: `quoteSummary:${modules}`,
      key: ticker.toUpperCase(),
      payload,
    });
  } catch (err) {
    logger.warn({ err: String(err), ticker }, "vendor_raw: yahoo quoteSummary store failed");
  }
}

/** Upsert canonical source_fundamentals. Skips nulls so a thin response cannot wipe a prior value. */
export async function persistMappedFields(
  ticker: string,
  source: string,
  fields: Record<string, number | undefined>,
): Promise<number> {
  const now = new Date();
  const rows = Object.entries(fields)
    .filter(([, v]) => v != null && Number.isFinite(v))
    .map(([field, value]) => ({
      ticker: ticker.toUpperCase(),
      source,
      field,
      value: String(value),
      fetchedAt: now,
    }));
  if (rows.length === 0) return 0;
  await ensureVendorRawSchema();
  const { db, sourceFundamentals } = await dbHandle();
  await db
    .insert(sourceFundamentals)
    .values(rows)
    .onConflictDoUpdate({
      target: [sourceFundamentals.ticker, sourceFundamentals.source, sourceFundamentals.field],
      set: { value: sql`excluded.value`, fetchedAt: sql`excluded.fetched_at` },
    });
  return rows.length;
}

export async function pruneVendorRaw(today = etDateKey()): Promise<number> {
  await ensureVendorRawSchema();
  const { pool } = await dbHandle();
  const res = await pool.query(
    `DELETE FROM vendor_raw WHERE fetched_on < ($1::date - ${RETENTION_DAYS})`,
    [today],
  );
  return res.rowCount ?? 0;
}

export const VENDOR_RAW_RETENTION_DAYS = RETENTION_DAYS;
export const VENDOR_RAW_GOLD_COLUMNS = GOLD_COLUMNS;
