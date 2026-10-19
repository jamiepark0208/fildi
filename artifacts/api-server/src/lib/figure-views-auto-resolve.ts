/**
 * A85 — auto-resolve figure_views vs prices_historical at horizon.
 * Only rows with explicit direction + horizon + mappable asset.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { resolveView } from "./figure-views.js";
import { logger } from "./logger.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

/** Map claim asset label → prices_historical ticker. */
export function assetToTicker(asset: string | null | undefined): string | null {
  if (!asset) return null;
  const a = asset.trim().toLowerCase();
  if (!a) return null;
  if (["spy", "spx", "equity", "equities", "market", "stocks", "s&p", "s&p500", "sp500"].includes(a)) {
    return "SPY";
  }
  if (["qqq", "nasdaq", "ndx"].includes(a)) return "QQQ";
  if (["iwm", "russell", "rut"].includes(a)) return "IWM";
  if (["rates", "rate", "bonds", "duration", "ust", "treasuries", "yields", "fed"].includes(a)) {
    return "TLT";
  }
  if (["gold", "gld"].includes(a)) return "GLD";
  if (["oil", "uso", "crude"].includes(a)) return "USO";
  // bare ticker (AAPL, BRK.B)
  if (/^[A-Z][A-Z0-9.]{0,9}$/i.test(asset.trim())) return asset.trim().toUpperCase();
  return null;
}

/** Parse horizon string → calendar days from as_of. null = unresolvable. */
export function horizonToDays(horizon: string | null | undefined, asOf: string): number | null {
  if (!horizon) return null;
  const h = horizon.trim().toLowerCase();
  if (!h) return null;
  const m = /^(\d+)\s*(d|day|days|w|wk|week|weeks|m|mo|month|months|y|yr|year|years)$/.exec(h);
  if (m) {
    const n = Number(m[1]);
    const u = m[2];
    if (u.startsWith("d")) return n;
    if (u.startsWith("w")) return n * 7;
    if (u.startsWith("m")) return n * 30;
    if (u.startsWith("y")) return n * 365;
  }
  if (h === "week" || h === "1w") return 7;
  if (h === "month" || h === "1m") return 30;
  if (h === "quarter" || h === "3m") return 90;
  if (h === "year" || h === "1y") return 365;
  if (h.includes("year-end") || h === "ye" || h === "eoy") {
    const y = Number(asOf.slice(0, 4));
    if (!Number.isFinite(y)) return null;
    const end = new Date(Date.UTC(y, 11, 31));
    const start = new Date(`${asOf}T00:00:00Z`);
    if (Number.isNaN(start.getTime())) return null;
    let days = Math.round((end.getTime() - start.getTime()) / 86_400_000);
    if (days < 7) {
      // after Dec 24-ish → next year-end
      const end2 = new Date(Date.UTC(y + 1, 11, 31));
      days = Math.round((end2.getTime() - start.getTime()) / 86_400_000);
    }
    return days;
  }
  return null;
}

/**
 * Did price move agree with direction?
 * TLT proxy for rates: hawkish → yields up → TLT down; dovish → TLT up.
 */
export function directionHit(
  direction: string,
  startClose: number,
  endClose: number,
  ticker: string,
): boolean | null {
  const d = direction.trim().toLowerCase();
  const up = endClose > startClose;
  const down = endClose < startClose;
  if (d === "bullish" || d === "up") return up;
  if (d === "bearish" || d === "down") return down;
  if (d === "neutral") return Math.abs(endClose / startClose - 1) < 0.01;
  if (ticker === "TLT") {
    if (d === "hawkish") return down; // rates up
    if (d === "dovish") return up;
  } else {
    // equity: hawkish often risk-off
    if (d === "hawkish") return down;
    if (d === "dovish") return up;
  }
  return null;
}

function addDays(iso: string, days: number): string {
  const t = new Date(`${iso}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
}

async function closeOnOrBefore(ticker: string, onOrBefore: string): Promise<{ close: number; date: string } | null> {
  const rows = rowsOf<{ close: number; date: string }>((await db.execute(sql`
    SELECT close::float8 AS close, date::text AS date
    FROM prices_historical
    WHERE ticker = ${ticker}
      AND date <= ${onOrBefore}::date
      AND date > (${onOrBefore}::date - 10)
      AND close > 0
    ORDER BY date DESC
    LIMIT 1`)) as SqlRows<never>);
  const r = rows[0];
  if (!r) return null;
  return { close: Number(r.close), date: String(r.date).slice(0, 10) };
}

export type AutoResolveResult = {
  scanned: number;
  resolved: number;
  skipped: number;
  errors: number;
};

/** Resolve open views that have direction + horizon + mappable asset. */
export async function autoResolveOpenViews(opts?: {
  limit?: number;
  asOfToday?: string;
  dryRun?: boolean;
}): Promise<AutoResolveResult> {
  const limit = opts?.limit ?? 80;
  const today = opts?.asOfToday ?? new Date().toISOString().slice(0, 10);
  const result: AutoResolveResult = { scanned: 0, resolved: 0, skipped: 0, errors: 0 };

  const open = rowsOf<{
    id: number;
    as_of: string;
    asset: string | null;
    direction: string | null;
    horizon: string | null;
    confidence: number | null;
  }>((await db.execute(sql`
    SELECT id, as_of::text AS as_of, asset, direction, horizon, confidence
    FROM figure_views
    WHERE resolved = false
      AND direction IS NOT NULL
      AND horizon IS NOT NULL
    ORDER BY as_of ASC, id ASC
    LIMIT ${limit}`)) as SqlRows<never>);

  result.scanned = open.length;

  for (const row of open) {
    try {
      const ticker = assetToTicker(row.asset);
      const days = horizonToDays(row.horizon, String(row.as_of).slice(0, 10));
      if (!ticker || days == null || !row.direction) {
        result.skipped++;
        continue;
      }
      const asOf = String(row.as_of).slice(0, 10);
      const resolveBy = addDays(asOf, days);
      if (resolveBy > today) {
        result.skipped++;
        continue;
      }
      const start = await closeOnOrBefore(ticker, asOf);
      const end = await closeOnOrBefore(ticker, resolveBy);
      if (!start || !end) {
        result.skipped++;
        continue;
      }
      const hit = directionHit(row.direction, start.close, end.close, ticker);
      if (hit == null) {
        result.skipped++;
        continue;
      }
      if (opts?.dryRun) {
        result.resolved++;
        continue;
      }
      await resolveView({
        id: Number(row.id),
        outcome: hit ? "hit" : "miss",
        forecastP: row.confidence != null ? Number(row.confidence) : null,
      });
      result.resolved++;
    } catch (err) {
      result.errors++;
      logger.warn({ err: String(err), id: row.id }, "figure-views-auto-resolve: row failed");
    }
  }
  return result;
}
