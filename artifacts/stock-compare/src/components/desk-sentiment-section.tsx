/**
 * Breakdown › Sentiment — desk/media lean, NOT Yahoo analyst recs (those live in Analyst Ratings).
 * Sources today: recent headlines (keyword lean) + latest earnings-call tone.
 * Next wire: StockTwits → X / Reddit → OpenJev (ASKS A214).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import type { NewsItem } from "./news-card";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";

type CallSummary = {
  tone_prepared?: number;
  tone_qa?: number;
  tone?: number;
  guidance?: string;
};
type Call = { quarter: string; summary: CallSummary; av_sentiment: number | null };

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

function toneLabel(v: number | null | undefined): { text: string; cls: string } {
  if (v == null || !Number.isFinite(v)) return { text: "—", cls: "text-white/50" };
  if (v > 0.3) return { text: `+${v.toFixed(1)}`, cls: "text-emerald-300" };
  if (v < -0.3) return { text: v.toFixed(1), cls: "text-red-300" };
  return { text: v.toFixed(1), cls: "text-amber-100" };
}

export function DeskSentimentSection({
  ticker,
  news,
}: {
  ticker: string;
  news: NewsItem[] | undefined;
}) {
  const { data: callData, isLoading } = useQuery({
    queryKey: ["earnings-call", ticker],
    queryFn: async (): Promise<{ calls: Call[] }> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/earnings-call`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60 * 60_000,
    enabled: !!ticker,
  });

  const lean = useMemo(() => headlineLean(news ?? []), [news]);
  const call = callData?.calls?.[0];
  const prep = call?.summary?.tone_prepared ?? call?.summary?.tone ?? null;
  const qa = call?.summary?.tone_qa ?? null;
  const av = call?.av_sentiment ?? null;
  const prepT = toneLabel(prep);
  const qaT = toneLabel(qa);
  const avT = toneLabel(av);

  const guide = call?.summary?.guidance;
  const guideCls =
    guide === "raised" || guide === "initiated"
      ? "text-emerald-300"
      : guide === "lowered" || guide === "withdrawn"
        ? "text-red-300"
        : "text-amber-100";

  const callLine = !call
    ? "No call summary queued yet"
    : [
        call.quarter,
        `script ${prepT.text}`,
        `Q&A ${qaT.text}`,
        av != null ? `AV ${avT.text}` : null,
        guide ? `guide ${guide}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

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
                {lean.label}
                <span className="block text-[10px] text-amber-50/80 mt-0.5">
                  {lean.n > 0
                    ? `${lean.bull} bull / ${lean.bear} bear · last ${Math.min(12, news?.length ?? 0)} headlines`
                    : "No scored headlines yet"}
                </span>
              </td>
            </tr>
            <tr className={gridRow(1)}>
              <td className={cn(GRID_TD, "text-[#d4af37] text-left font-semibold")}>Last call</td>
              <td className={cn(GRID_TD, "text-left whitespace-normal leading-snug")}>
                {isLoading ? (
                  <span className="text-white/70">Loading…</span>
                ) : call ? (
                  <span className="text-white font-mono">
                    <span className="text-amber-50">{call.quarter}</span>
                    {" · "}
                    <span className={prepT.cls}>script {prepT.text}</span>
                    {" · "}
                    <span className={qaT.cls}>Q&A {qaT.text}</span>
                    {av != null && (
                      <>
                        {" · "}
                        <span className={avT.cls}>AV {avT.text}</span>
                      </>
                    )}
                    {guide && (
                      <>
                        {" · "}
                        <span className={cn("font-sans font-semibold", guideCls)}>guide {guide}</span>
                      </>
                    )}
                  </span>
                ) : (
                  <span className="text-white/70 italic">{callLine}</span>
                )}
              </td>
            </tr>
            <tr className={gridRow(2)}>
              <td className={cn(GRID_TD, "text-[#d4af37] text-left font-semibold")}>Next</td>
              <td className={cn(GRID_TD, "text-amber-50 text-left whitespace-normal leading-snug")}>
                StockTwits stream first (A214), then X / Reddit + OpenJev classify. Not Yahoo recs.
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
