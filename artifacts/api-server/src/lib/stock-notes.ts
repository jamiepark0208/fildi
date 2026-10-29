// Per-ticker desk notes (Jamie 10-28): short, dated stock/options context that took analysis to learn —
// good/bad trades, earnings behaviour, levels, backtest results, character. One home: fund_score_notes
// (tags carry the kind; adj_points stays null for these). Agents add them with scripts/stock_notes.py.
// Every note is dated history, not a forecast — readers must say so when they use one.
import { desc, eq } from "drizzle-orm";
import { db, fundScoreNotes } from "@workspace/db";

export const NOTE_KINDS = ["trade", "earnings", "levels", "backtest", "character", "lesson", "thesis"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export const NOTE_MAX_CHARS = 280;

export interface StockNote {
  id: number;
  asOf: string;
  kind: string;
  body: string;
  author: string | null;
  source: string | null;
}

export function noteKind(tags: unknown): string {
  const t = Array.isArray(tags) ? tags.map(String) : [];
  return t.find(x => (NOTE_KINDS as readonly string[]).includes(x)) ?? "note";
}

function noteSource(tags: unknown): string | null {
  const t = Array.isArray(tags) ? tags.map(String) : [];
  return t.find(x => x.startsWith("src:"))?.slice(4) ?? null;
}

/** Newest first; expired notes dropped. */
export async function readStockNotes(ticker: string, limit = 6): Promise<StockNote[]> {
  const rows = await db.select().from(fundScoreNotes)
    .where(eq(fundScoreNotes.ticker, ticker.toUpperCase()))
    .orderBy(desc(fundScoreNotes.asOf), desc(fundScoreNotes.createdAt))
    .limit(limit * 2);
  const now = Date.now();
  return rows
    .filter(r => !r.expiresAt || r.expiresAt.getTime() > now)
    .slice(0, limit)
    .map(r => ({
      id: r.id,
      asOf: String(r.asOf).slice(0, 10),
      kind: noteKind(r.tags),
      body: r.body,
      author: r.author,
      source: noteSource(r.tags),
    }));
}

/** One line per note for AI prompts: "2026-10-28 earnings: … (S126)". */
export function noteLines(notes: StockNote[]): string[] {
  return notes.map(n => `${n.asOf} ${n.kind}: ${n.body}${n.source ? ` (${n.source})` : ""}`);
}
