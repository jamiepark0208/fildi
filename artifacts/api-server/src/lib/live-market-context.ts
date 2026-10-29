/**
 * One Live › Market conviction strip payload: Kalshi 15m + desk lean + regime grades.
 * Sub-caches stay separate so a Kalshi blip never blocks grades / desk.
 */
import { sql, and, eq, gte, inArray } from "drizzle-orm";
import { db, intradayCheckpointGrades } from "@workspace/db";
import { TTLCache } from "./ttl-cache.js";
import {
  fetchKalshiPredMarketsBundle,
  type KalshiFifteenUpDown,
  type FomcOdds,
  type CpiOdds,
} from "./kalshi-macro.js";

export type DeskLean = "bullish" | "bearish" | "mixed" | "thin";

export interface DeskLeanSummary {
  lean: DeskLean;
  n: number;
  avgDir: number;
  bullN: number;
  bearN: number;
  note: string;
}

export interface RegimeAccuracySummary {
  lookbackDays: number;
  n: number;
  correct: number;
  incorrect: number;
  correctPct: number | null;
  note: string;
  /** S126 risk call graded live: share of checkpoints at each level followed by a ≥ 0.5 ATR drop before the close. */
  risk: Partial<Record<"calm" | "normal" | "elevated" | "stormy", { n: number; pDrop: number }>>;
}

export interface LiveMarketContext {
  asOf: string;
  btc15m: KalshiFifteenUpDown | null;
  ndq15m: KalshiFifteenUpDown | null;
  fomc: FomcOdds | null;
  cpi: CpiOdds | null;
  deskLean: DeskLeanSummary | null;
  regimeAccuracy: RegimeAccuracySummary | null;
  kalshiNote: string;
}

const deskLeanCache = new TTLCache<DeskLeanSummary | null>(5 * 60_000, "live-desk-lean", 4);
const accuracyCache = new TTLCache<RegimeAccuracySummary | null>(30 * 60_000, "live-regime-accuracy", 4);
const bundleCache = new TTLCache<LiveMarketContext>(45_000, "live-market-context", 4);

async function loadDeskLean(): Promise<DeskLeanSummary | null> {
  return deskLeanCache.getOrCompute("36h", async () => {
    try {
      const since = new Date(Date.now() - 36 * 3600_000).toISOString();
      const rows = await db.execute(sql`
        SELECT dir::float AS dir
        FROM watchlist_sync.openjev_headline_labels
        WHERE ts >= ${since}::timestamptz AND rel > 0.5
        ORDER BY ABS(dir) DESC
        LIMIT 80`);
      const list = (Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? []) as Array<{ dir: number }>;
      if (list.length < 3) {
        return {
          lean: "thin",
          n: list.length,
          avgDir: 0,
          bullN: 0,
          bearN: 0,
          note: "OpenJev desk labels thin — display only (S037: no next-day trade IC)",
        };
      }
      let bullN = 0;
      let bearN = 0;
      let sum = 0;
      for (const r of list) {
        const d = Number(r.dir);
        if (!Number.isFinite(d)) continue;
        sum += d;
        if (d > 0.15) bullN += 1;
        else if (d < -0.15) bearN += 1;
      }
      const avgDir = Math.round((sum / list.length) * 100) / 100;
      let lean: DeskLean = "mixed";
      if (bullN >= bearN + 2 && avgDir > 0.08) lean = "bullish";
      else if (bearN >= bullN + 2 && avgDir < -0.08) lean = "bearish";
      return {
        lean,
        n: list.length,
        avgDir,
        bullN,
        bearN,
        note: "Desk/OpenJev headline lean — context for conviction, not a score input (S037)",
      };
    } catch {
      return null;
    }
  });
}

async function loadRegimeAccuracy(): Promise<RegimeAccuracySummary | null> {
  return accuracyCache.getOrCompute("spy-40d", async () => {
    try {
      const lookbackDays = 40;
      const since = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
      const rows = await db
        .select({ grade: intradayCheckpointGrades.grade, riskLevel: intradayCheckpointGrades.riskLevel, restDropAtr: intradayCheckpointGrades.restDropAtr })
        .from(intradayCheckpointGrades)
        .where(and(
          eq(intradayCheckpointGrades.ticker, "SPY"),
          gte(intradayCheckpointGrades.date, since),
        ))
        .limit(4000);
      let correct = 0;
      let incorrect = 0;
      const risk: RegimeAccuracySummary["risk"] = {};
      const hits: Record<string, { n: number; drops: number }> = {};
      for (const r of rows) {
        if (r.grade === "correct") correct += 1;
        else if (r.grade === "incorrect") incorrect += 1;
        if (r.riskLevel && r.restDropAtr != null) {
          const h = (hits[r.riskLevel] ??= { n: 0, drops: 0 });
          h.n += 1;
          if (Number(r.restDropAtr) <= -0.5) h.drops += 1;
        }
      }
      for (const [lvl, h] of Object.entries(hits)) {
        risk[lvl as keyof RegimeAccuracySummary["risk"]] = { n: h.n, pDrop: Math.round((100 * h.drops) / h.n) };
      }
      const n = correct + incorrect;
      return {
        lookbackDays,
        n,
        correct,
        incorrect,
        correctPct: n >= 8 ? Math.round((100 * correct) / n) : null,
        note: n < 8
          ? "Need ≥8 graded SPY checkpoints (nightly grade vs close)"
          : "SPY checkpoint direction vs close — flat/mixed excluded (S126: no edge, 49.5% over 2 yrs)",
        risk,
      };
    } catch {
      return null;
    }
  });
}

export async function getLiveMarketContext(): Promise<LiveMarketContext> {
  return bundleCache.getOrCompute("v1", async () => {
    const [kalshi, deskLean, regimeAccuracy] = await Promise.all([
      fetchKalshiPredMarketsBundle().catch(() => null),
      loadDeskLean(),
      loadRegimeAccuracy(),
    ]);
    return {
      asOf: new Date().toISOString(),
      btc15m: kalshi?.btc15m ?? null,
      ndq15m: kalshi?.ndq15m ?? null,
      fomc: kalshi?.fomc ?? null,
      cpi: kalshi?.cpi ?? null,
      deskLean,
      regimeAccuracy,
      kalshiNote: kalshi?.intradayNote
        ?? "Kalshi internal display only",
    };
  });
}
