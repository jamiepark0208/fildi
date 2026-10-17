/**
 * One nightly enrichment at a time across processes (API scheduler and Maintain).
 * Session-level advisory lock: the same connection must unlock.
 */
export const ENRICHMENT_LOCK_CLASS = 424242;
export const ENRICHMENT_LOCK_OBJ = 1;

export type LockClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ ok?: boolean }> }>;
  release: () => void;
};

export async function tryWithEnrichmentLock(
  connect: () => Promise<LockClient>,
  fn: () => Promise<void>,
): Promise<"ran" | "busy"> {
  const client = await connect();
  let held = false;
  try {
    const res = await client.query("SELECT pg_try_advisory_lock($1, $2) AS ok", [
      ENRICHMENT_LOCK_CLASS,
      ENRICHMENT_LOCK_OBJ,
    ]);
    if (!res.rows[0]?.ok) return "busy";
    held = true;
    await fn();
    return "ran";
  } finally {
    if (held) {
      await client.query("SELECT pg_advisory_unlock($1, $2)", [ENRICHMENT_LOCK_CLASS, ENRICHMENT_LOCK_OBJ]);
    }
    client.release();
  }
}
