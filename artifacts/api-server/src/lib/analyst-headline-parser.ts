/**
 * Heuristic fallback for per-ticker analyst signal: we already fetch per-symbol
 * news headlines on-demand (yahooFinance.search in stocks.ts) — this just regex-
 * scans those titles for rating-change / price-target phrasing, e.g. "Insulet
 * downgraded to Hold from Buy at Truist" or "PT Raised to $190 at JPMorgan".
 *
 * Lower confidence than the FMP-archived rows (fmp-analyst-feed.ts) — headline
 * wording varies by publisher and a miss just means no entry, not a wrong one —
 * so callers should tag these `source: "headline"` and let the UI flag them as
 * such rather than treating them as equally reliable.
 */

export interface ParsedHeadlineEvent {
  firm: string;
  action: "upgrade" | "downgrade" | "initiate" | "maintain" | "reiterate" | "price-target";
  fromGrade: string | null;
  toGrade: string | null;
  priceTarget: number | null;
}

const ACTION_WORDS: Record<string, ParsedHeadlineEvent["action"]> = {
  upgraded: "upgrade",
  downgraded: "downgrade",
  initiated: "initiate",
  maintained: "maintain",
  reiterated: "reiterate",
};

const FIRM_RE = /\bat\s+([A-Z][A-Za-z0-9&.,'\- ]{2,40}?)(?:\s+after\b|\s+following\b|[.,]|$)/;
const GRADE_RE = /\bto\s+([A-Za-z][A-Za-z ]{1,20}?)\s+from\s+([A-Za-z][A-Za-z ]{1,20}?)(?:\s+at\b|$)/i;
const ACTION_RE = /\b(upgraded|downgraded|initiated|maintained|reiterated)\b/i;
const PRICE_TARGET_RE = /(?:price target|\bPT\b)[^$\d]{0,20}\$\s?([\d,]+(?:\.\d+)?)/i;

export function parseAnalystHeadline(title: string): ParsedHeadlineEvent | null {
  if (!title) return null;

  const firmMatch = title.match(FIRM_RE);
  if (!firmMatch) return null;
  const firm = firmMatch[1].trim();
  if (firm.length < 2) return null;

  const actionMatch = title.match(ACTION_RE);
  const gradeMatch = title.match(GRADE_RE);
  const ptMatch = title.match(PRICE_TARGET_RE);

  const priceTarget = ptMatch ? parseFloat(ptMatch[1].replace(/,/g, "")) : null;
  const action = actionMatch ? ACTION_WORDS[actionMatch[1].toLowerCase()] : null;

  if (!action && priceTarget == null) return null;

  return {
    firm,
    action: action ?? "price-target",
    toGrade: gradeMatch ? gradeMatch[1].trim() : null,
    fromGrade: gradeMatch ? gradeMatch[2].trim() : null,
    priceTarget,
  };
}

/** De-dupe by firm (keep first/most-recent occurrence) and cap the fallback list. */
export function parseAnalystHeadlines(
  items: Array<{ title: string; publishedAt: string | null }>,
  maxResults = 5,
): Array<ParsedHeadlineEvent & { date: string | null }> {
  const seenFirms = new Set<string>();
  const out: Array<ParsedHeadlineEvent & { date: string | null }> = [];

  for (const item of items) {
    const parsed = parseAnalystHeadline(item.title);
    if (!parsed) continue;
    const key = parsed.firm.toLowerCase();
    if (seenFirms.has(key)) continue;
    seenFirms.add(key);
    out.push({ ...parsed, date: item.publishedAt ? item.publishedAt.slice(0, 10) : null });
    if (out.length >= maxResults) break;
  }

  return out;
}
