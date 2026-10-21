/**
 * Rankings › Structures backtest panel (S076, A192 Phase 2). Reads watchlist_sync.structure_backtest (one row per structure,
 * written by scripts/watchlist_sync/analysis/s076_structures_backtest.py) joined to the board catalog for names.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

export async function readStructureBacktest(): Promise<{
  asOf: string | null;
  structures: Array<{ id: string; name: string; family: string; description: string } & Record<string, unknown>>;
}> {
  try {
    const { rows } = await db.execute(sql`
      SELECT b.structure, b.as_of::text AS as_of, b.payload, c.name, c.family, c.description
      FROM watchlist_sync.structure_backtest b
      LEFT JOIN watchlist_sync.structure_catalog c ON c.id = b.structure`);
    const list = (rows as Array<Record<string, unknown>>).map((r) => ({
      ...(r.payload as Record<string, unknown>),
      id: String(r.structure),
      name: String(r.name ?? r.structure),
      family: String(r.family ?? ""),
      description: String(r.description ?? ""),
    }));
    const asOf = list.length ? String((rows[0] as Record<string, unknown>).as_of) : null;
    return { asOf, structures: list };
  } catch (err) {
    logger.warn({ err: String(err) }, "structure backtest unavailable");
    return { asOf: null, structures: [] };
  }
}
