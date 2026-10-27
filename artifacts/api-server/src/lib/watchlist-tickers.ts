import { and, eq } from "drizzle-orm";
import { db, watchlist } from "@workspace/db";
import { WATCHLIST } from "./constants.js";

/** Tickers on a specific user's watchlist. */
export async function getUserWatchlistTickers(userId: number): Promise<string[]> {
  const rows = await db.select({ ticker: watchlist.ticker })
    .from(watchlist)
    .where(eq(watchlist.userId, userId));
  return rows.map(r => r.ticker);
}

/**
 * Names that trade with the AI build-out but sat outside every list (Jamie 10-27: "semis correlate with data centers, rare earth
 * metals — why none of those?"): data-center power, uranium/nuclear, rare earths/lithium, bitcoin miners/AI hosting, networking.
 * Coverage only — they still pass the same gates and lanes as every other name.
 */
export const THEME_UNIVERSE = [
  "VRT", "CEG", "VST", "TLN", "SMR", "NNE", "CCJ", "UUUU", "LEU", "CRML", "TMC", "NB", "ALB", "LAC",
  "APLD", "CIFR", "WULF", "CORZ", "BTDR", "GLXY", "CRDO", "ALAB", "COHR", "CLS", "AMKR", "NVTS", "POWL", "EOSE",
];

/**
 * Distinct tickers across every user's watchlist, unioned with the seed `WATCHLIST`
 * constant and THEME_UNIVERSE so scorecard/seeder pipelines never drop below the default coverage set.
 */
export async function getUnionWatchlistTickers(): Promise<string[]> {
  const rows = await db.selectDistinct({ ticker: watchlist.ticker }).from(watchlist);
  return [...new Set([...WATCHLIST, ...THEME_UNIVERSE, ...rows.map(r => r.ticker)])];
}

/** Whether `ticker` is on the given user's watchlist (already normalized/uppercased). */
export async function isTickerOnUserWatchlist(userId: number, ticker: string): Promise<boolean> {
  const rows = await db.select({ ticker: watchlist.ticker })
    .from(watchlist)
    .where(and(eq(watchlist.userId, userId), eq(watchlist.ticker, ticker)))
    .limit(1);
  return rows.length > 0;
}
