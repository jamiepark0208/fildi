/** Awareness tags on sold puts (book_group, news) — display + AI explain only; never gates. */

export type BookGroupAwareness = {
  list: string[];
  held: string[];
  corr: number;
  same_expiry: number;
  of_list: number;
};

export type NewsAwareness = {
  gap?: { move_pct: number; sigma: number; vs_close: string } | null;
  filings_8k?: string[];
  note?: string;
};

export type PutEngineAwareness = {
  book_group?: BookGroupAwareness;
  news?: NewsAwareness;
};

export function bookGroupPromptLine(ticker: string, bg: BookGroupAwareness | undefined): string | null {
  if (!bg?.list || bg.list.length < 2) return null;
  const upper = ticker.toUpperCase();
  const mates = bg.list.filter((t) => t.toUpperCase() !== upper);
  const names = (mates.length ? mates : bg.list).join(" ");
  const held = bg.held?.length ? `; held ${bg.held.join(" ")}` : "";
  return `Moves with ${names} (corr ${bg.corr}, ${bg.same_expiry} same expiry${held}).`;
}

export function newsPromptLine(news: NewsAwareness | undefined): string | null {
  if (!news) return null;
  const parts: string[] = [];
  if (news.gap) {
    const g = news.gap;
    const pct = g.move_pct >= 0 ? `+${g.move_pct}` : `${g.move_pct}`;
    parts.push(`${pct} % vs ${g.vs_close} close (${g.sigma}σ)`);
  }
  if (news.filings_8k?.length) parts.push(news.filings_8k.join("; "));
  if (!parts.length) return null;
  const tail = news.note ? ` — ${news.note.replace(/\.$/, "")}` : "";
  return `News: ${parts.join("; ")}${tail}.`;
}

export function engineAwarenessFromContract(contract: Record<string, unknown> | null | undefined): PutEngineAwareness {
  const eng = contract?.engine;
  if (!eng || typeof eng !== "object") return {};
  const e = eng as PutEngineAwareness;
  return { book_group: e.book_group, news: e.news };
}
