/** Chip labels for put engine awareness (book_group, news) — mirrors api-server model-list-awareness.ts */

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

export function engineAwareness(contract: { engine?: PutEngineAwareness } | null | undefined): PutEngineAwareness {
  return contract?.engine ?? {};
}

export function bookGroupChip(bg: BookGroupAwareness | undefined): { label: string; tip: string } | null {
  if (!bg?.list || bg.list.length < 2 || !bg.of_list) return null;
  const held = bg.held?.length ? ` · holds ${bg.held.join(", ")}` : "";
  const mates = bg.list.join(", ");
  const tip = `${mates} · corr ${bg.corr} · ${bg.same_expiry} same expiry${bg.held?.length ? ` · held ${bg.held.join(", ")}` : ""}`;
  return { label: `moves with ${bg.list.length} of ${bg.of_list}${held}`, tip };
}

function filingShort(line: string): string {
  const m = line.match(/\d{4}-\d{2}-\d{2}\s+(.+)/);
  const tail = m ? m[1]! : line;
  return tail.replace(/_/g, " ").replace(/\s+or\s+update$/i, "").trim();
}

export function newsChip(news: NewsAwareness | undefined): { label: string; tip: string } | null {
  if (!news) return null;
  if (news.gap) {
    const g = news.gap;
    const pct = g.move_pct >= 0 ? `+${g.move_pct}` : `${g.move_pct}`;
    const filings = news.filings_8k?.length ? `\n8-K: ${news.filings_8k.join("; ")}` : "";
    return {
      label: `news ${pct} % (${g.sigma}σ)`,
      tip: `${news.note ?? "awareness only"} · vs ${g.vs_close} close${filings}`,
    };
  }
  if (news.filings_8k?.length) {
    const short = filingShort(news.filings_8k[0]!);
    return {
      label: `8-K: ${short.slice(0, 24)}`,
      tip: [news.note, ...news.filings_8k].filter(Boolean).join("\n"),
    };
  }
  return null;
}
