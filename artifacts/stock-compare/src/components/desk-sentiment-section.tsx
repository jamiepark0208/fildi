/**
 * Breakdown › Sentiment — desk/media lean, NOT Yahoo analyst recs (those live in Analyst Ratings).
 * Sources: StockTwits + earnings-call tone (A214 media_sentiment_daily) + headline keyword lean (weak).
 * Display only — never feeds scores until a study row exists.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import type { NewsItem } from "./news-card";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";

type MediaSource = {
  as_of: string;
  source: string;
  score: number | null;
  n: number | null;
  sample: { bull?: number; bear?: number; quarter?: string; guidance?: string | null } | null;
  fetched_at: string;
};

const BULL =
  /\b(beat|beats|surge|surges|rally|rallies|upgrade|upgrades|raised|raises|record|outperform|bullish|soar|soars|jump|jumps|strong\s+demand)\b/i;
const BEAR =
  /\b(miss|misses|cut|cuts|downgrade|downgrades|lowered|lowers|lawsuit|probe|investigation|weak|delay|delays|layoff|bankrupt|dilut|warning|plunge|plunges|slump)\b/i;

function headlineLean(news: NewsItem[]): { bull: number; bear: number; n: number; label: string } {
  let bull = 0;
  let bear = 0;
  for (const item of news.slice(0, 12)) {
    const t = item.title ?? "";
    const b = BULL.test(t);
    const r = BEAR.test(t);
    if (b && !r) bull++;
    else if (r && !b) bear++;
  }
  const n = bull + bear;
  let label = "Mixed / thin";
  if (n >= 2) {
    if (bull >= bear + 2) label = "Headlines lean bullish";
    else if (bear >= bull + 2) label = "Headlines lean cautious";
    else label = "Headlines mixed";
  } else if (n === 1) {
    label = bull ? "1 bullish headline" : "1 cautious headline";
  }
  return { bull, bear, n, label };
}

function scoreLabel(score: number | null | undefined): { text: string; cls: string } {
  if (score == null || !Number.isFinite(score)) return { text: "no tagged lean", cls: "text-white/50" };
  if (score > 0.25) return { text: `bullish ${score.toFixed(2)}`, cls: "text-emerald-300" };
  if (score < -0.25) return { text: `cautious ${score.toFixed(2)}`, cls: "text-red-300" };
  return { text: `mixed ${score.toFixed(2)}`, cls: "text-amber-100" };
}

function asOfLabel(asOf: string | undefined, fetchedAt: string | undefined): string {
  const day = (asOf ?? fetchedAt ?? "").slice(0, 10);
  if (!day) return "as-of —";
  const ageDays = Math.max(0, Math.floor((Date.now() - Date.parse(`${day}T12:00:00Z`)) / 86_400_000));
  if (ageDays === 0) return `as-of ${day} · today`;
  if (ageDays === 1) return `as-of ${day} · 1d stale`;
  return `as-of ${day} · ${ageDays}d stale`;
}

export function DeskSentimentSection({
  ticker,
  news,
}: {
  ticker: string;
  news: NewsItem[] | undefined;
}) {
  const { data: media, isLoading } = useQuery({
    queryKey: ["media-sentiment", ticker],
    queryFn: async (): Promise<{ sources: MediaSource[]; note?: string }> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/media-sentiment`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
    enabled: !!ticker,
  });

  const lean = useMemo(() => headlineLean(news ?? []), [news]);
  const bySource = useMemo(() => {
    const m = new Map<string, MediaSource>();
    for (const s of media?.sources ?? []) m.set(s.source, s);
    return m;
  }, [media?.sources]);

  const st = bySource.get("stocktwits");
  const call = bySource.get("call_tone");
  const stL = scoreLabel(st?.score);
  const callL = scoreLabel(call?.score);

  const compositeParts: number[] = [];
  if (st?.score != null) compositeParts.push(st.score);
  if (call?.score != null) compositeParts.push(call.score);
  const composite =
    compositeParts.length > 0
      ? compositeParts.reduce((a, b) => a + b, 0) / compositeParts.length
      : null;
  const compL = scoreLabel(composite);

  return (
    <div className="space-y-2 text-[11px]">
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-left w-28")}>Source</th>
              <th className={cn(GRID_TH, "text-left")}>Lean</th>
            </tr>
          </thead>
          <tbody>
            <tr className={gridRow(0)}>
              <td className={cn(GRID_TD, "text-[#d4af37] text-left font-semibold")}>Desk lean</td>
              <td className={cn(GRID_TD, "text-white text-left whitespace-normal leading-snug")}>
                {isLoading ? (
                  <span className="text-white/70">Loading…</span>
                ) : compositeParts.length > 0 ? (
                  <>
                    <span className={cn("font-mono font-semibold", compL.cls)}>{compL.text}</span>
                    <span className="block text-[10px] text-amber-50/80 mt-0.5">
                      StockTwits + call tone average · display only (A214)
                    </span>
                  </>
                ) : (
                  <>
                    <span className="text-white/70 italic">No media source yet for {ticker}</span>
                    <span className="block text-[10px] text-amber-50/70 mt-0.5">
                      Keyword headlines below are weak — not a substitute
                    </span>
                  </>
                )}
              </td>
            </tr>
            <tr className={gridRow(1)}>
              <td className={cn(GRID_TD, "text-[#d4af37] text-left font-semibold")}>StockTwits</td>
              <td className={cn(GRID_TD, "text-left whitespace-normal leading-snug")}>
                {st ? (
                  <span className="font-mono">
                    <span className={stL.cls}>{stL.text}</span>
                    <span className="block text-[10px] text-amber-50/80 mt-0.5">
                      {st.sample?.bull ?? 0} bull / {st.sample?.bear ?? 0} bear · n={st.n ?? 0} ·{" "}
                      {asOfLabel(st.as_of, st.fetched_at)}
                    </span>
                  </span>
                ) : (
                  <span className="text-white/60 italic">No StockTwits row yet</span>
                )}
              </td>
            </tr>
            <tr className={gridRow(2)}>
              <td className={cn(GRID_TD, "text-[#d4af37] text-left font-semibold")}>Last call</td>
              <td className={cn(GRID_TD, "text-left whitespace-normal leading-snug")}>
                {call ? (
                  <span className="font-mono">
                    <span className={callL.cls}>{callL.text}</span>
                    <span className="block text-[10px] text-amber-50/80 mt-0.5">
                      {call.sample?.quarter ?? "—"}
                      {call.sample?.guidance ? ` · guide ${call.sample.guidance}` : ""} ·{" "}
                      {asOfLabel(call.as_of, call.fetched_at)}
                    </span>
                  </span>
                ) : (
                  <span className="text-white/60 italic">No call-tone row yet</span>
                )}
              </td>
            </tr>
            <tr className={gridRow(3)}>
              <td className={cn(GRID_TD, "text-[#d4af37] text-left font-semibold")}>Headlines</td>
              <td className={cn(GRID_TD, "text-white text-left whitespace-normal leading-snug")}>
                {lean.label}
                <span className="block text-[10px] text-amber-50/70 mt-0.5">
                  Keyword heuristic ·{" "}
                  {lean.n > 0
                    ? `${lean.bull} bull / ${lean.bear} bear · last ${Math.min(12, news?.length ?? 0)}`
                    : "unvalidated"}{" "}
                  · not a score input
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-[9px] text-amber-200/35">
        Never Yahoo rec %. OpenJev headline classify = Live strip only (tier B). X/Reddit later.
      </p>
    </div>
  );
}
