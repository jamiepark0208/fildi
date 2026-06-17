import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NewsHeadline {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  tickers?: string[];
}

export const MacroHighlightsBulletSchema = z.object({
  id: z.string(),
  category: z.enum(["tape", "macro", "sector", "watchlist", "event", "geopolitical"]),
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()).optional(),
  tickers: z.array(z.string()).optional(),
  metric: z
    .object({
      label: z.string(),
      value: z.string(),
      direction: z.enum(["up", "down", "flat"]).optional(),
    })
    .optional(),
});

export const MacroHighlightsPayloadSchema = z.object({
  generatedAt: z.string(),
  marketDate: z.string(),
  headline: z.string(),
  eventsToday: z.array(
    z.object({
      date: z.string(),
      event: z.string(),
      importance: z.enum(["high", "medium", "low"]),
    }),
  ),
  bullets: z.array(MacroHighlightsBulletSchema).max(10),
  watchlistMovers: z.array(
    z.object({
      ticker: z.string(),
      changePct: z.number(),
      blurb: z.string(),
    }),
  ),
});

export type MacroHighlightsPayload = z.infer<typeof MacroHighlightsPayloadSchema>;

// ── Headline helpers ────────────────────────────────────────────────────────────

export function normalizeHeadlineTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&amp;/g, "and")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function dedupeHeadlines(headlines: NewsHeadline[]): NewsHeadline[] {
  const seen: string[] = [];
  const out: NewsHeadline[] = [];

  for (const h of headlines) {
    const norm = normalizeHeadlineTitle(h.title);
    if (norm.length < 12) continue;

    const isDupe = seen.some(
      (s) => s === norm || s.includes(norm) || norm.includes(s),
    );
    if (isDupe) continue;

    seen.push(norm);
    out.push(h);
  }

  return out;
}

export function parseMacroHighlightsPayload(raw: unknown): MacroHighlightsPayload | null {
  const result = MacroHighlightsPayloadSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function fallbackHighlightsPayload(
  marketDate: string,
  message: string,
): MacroHighlightsPayload {
  return {
    generatedAt: new Date().toISOString(),
    marketDate,
    headline: "Highlights unavailable",
    eventsToday: [],
    bullets: [
      {
        id: "error",
        category: "tape",
        title: "Generation failed",
        body: message.slice(0, 120),
      },
    ],
    watchlistMovers: [],
  };
}
