import type { StockPicks } from "@workspace/db";

export const MAX_PICKS_PER_STANCE = 5;
export const STANCES = ["bullish", "neutral", "bearish"] as const;
export type Stance = (typeof STANCES)[number];

const TICKER_RE = /^[A-Z][A-Z0-9.-]{0,9}$/;

export function normalizeTickerList(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const t = item.trim().toUpperCase();
    if (!TICKER_RE.test(t)) return null;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length > MAX_PICKS_PER_STANCE) return null;
  }
  return out;
}

export function coerceStockPicks(raw: unknown): StockPicks {
  if (!raw || typeof raw !== "object") return { bullish: [], neutral: [], bearish: [] };
  const obj = raw as Record<string, unknown>;
  return {
    bullish: normalizeTickerList(obj.bullish) ?? [],
    neutral: normalizeTickerList(obj.neutral) ?? [],
    bearish: normalizeTickerList(obj.bearish) ?? [],
  };
}

export function parseStockPicksPatch(
  body: unknown,
  current: StockPicks,
): { picks: StockPicks } | { error: string } {
  if (!body || typeof body !== "object") {
    return { error: "Invalid body" };
  }
  const patch = body as Record<string, unknown>;
  const next: StockPicks = { ...current };

  for (const stance of STANCES) {
    if (patch[stance] === undefined) continue;
    const list = normalizeTickerList(patch[stance]);
    if (list === null) {
      return {
        error: `Invalid ${stance} list — max ${MAX_PICKS_PER_STANCE} unique tickers (1–10 chars)`,
      };
    }
    next[stance] = list;
  }

  return { picks: next };
}
