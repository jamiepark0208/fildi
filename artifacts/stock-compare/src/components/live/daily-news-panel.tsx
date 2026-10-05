/**
 * Live → News: Haiku Daily News generate + feedback loop.
 * Session-aware (weekend pack Fri→Sun). Feedback feeds next Generate.
 */
import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Clock, MessageCircleQuestion, RefreshCw, Sparkles, ThumbsDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";

interface DailyNewsSummary {
  content: string;
  generatedAt: string;
  emailCount: number;
  includedCount?: number;
  maxReceivedAt: string | null;
  sources: string[];
  categories?: string[];
  sessionStartPt?: string;
}

interface DailyNewsResponse {
  date: string;
  sessionStartPt?: string;
  sessionLabel?: string;
  isWeekendPack?: boolean;
  todayCount: number;
  includedCount?: number;
  excludedCount?: number;
  maxReceivedAt: string | null;
  newSinceLastSummary: number;
  summary: DailyNewsSummary | null;
  message?: string;
}

async function fetchDailyNews(): Promise<DailyNewsResponse> {
  const r = await fetch("/api/desk-commentaries/daily-news", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function renderBrief(
  md: string,
  onNotRelevant?: (bullet: string) => void,
) {
  return md.split("\n").map((line, i) => {
    const t = line.trim();
    if (!t) return <div key={i} className="h-1.5" />;
    if (t.startsWith("## ")) {
      return (
        <p key={i} className="text-[10px] font-bold uppercase tracking-wide text-[#d4af37] mt-2.5 mb-1">
          {t.slice(3)}
        </p>
      );
    }
    if (t.startsWith("- ") || t.startsWith("* ")) {
      const bullet = t.slice(2);
      return (
        <div key={i} className="group flex items-start gap-1 mb-1">
          <p className="flex-1 text-[12px] text-amber-50/85 leading-snug pl-2 border-l border-[#d4af37]/20">
            {bullet}
          </p>
          {onNotRelevant && (
            <button
              type="button"
              title="Not relevant — tell the model why on next Generate"
              onClick={() => onNotRelevant(bullet)}
              className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-600 hover:text-red-400 transition-opacity"
            >
              <ThumbsDown className="w-3 h-3" />
            </button>
          )}
        </div>
      );
    }
    return (
      <p key={i} className="text-[12px] text-amber-50/85 leading-snug mb-1">{t}</p>
    );
  });
}

export function DailyNewsPanel({ compact = false }: { compact?: boolean }) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askWhy, setAskWhy] = useState("");
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["desk-daily-news"],
    queryFn: fetchDailyNews,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const refresh = useCallback(async () => {
    setGenerating(true);
    setError(null);
    setFeedbackMsg(null);
    try {
      const r = await fetch("/api/desk-commentaries/daily-news/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      const next = (await r.json()) as DailyNewsResponse;
      queryClient.setQueryData(["desk-daily-news"], next);
      queryClient.invalidateQueries({ queryKey: ["desk-session"] });
    } catch (e: any) {
      setError(e?.message ?? "Failed to generate");
    } finally {
      setGenerating(false);
    }
  }, [queryClient]);

  const sendFeedback = useCallback(async (body: {
    feedbackType: "not_relevant" | "ask_why" | "want_more";
    bulletText?: string;
    reason?: string;
    question?: string;
  }) => {
    const r = await fetch("/api/desk-commentaries/daily-news/feedback", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, sessionDate: data?.date }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "feedback failed");
    setFeedbackMsg("Saved — next Generate will honor this.");
  }, [data?.date]);

  const summary = data?.summary ?? null;
  const newCount = data?.newSinceLastSummary ?? 0;
  const genTime = summary?.generatedAt
    ? new Date(summary.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;

  return (
    <div className={cn(
      "rounded-md border border-[#d4af37]/25 bg-zinc-950 overflow-hidden",
      !compact && "shadow-lg shadow-black/60",
    )}>
      <div className="px-2.5 py-1.5 flex items-center justify-between border-b border-[#d4af37]/15 gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#d4af37]">
            <Sparkles className="w-3 h-3 shrink-0" />
            Daily News
            {data && (
              <span className="text-[10px] font-mono font-normal text-amber-200/40 normal-case tracking-normal truncate">
                · {data.includedCount ?? "?"} in / {data.todayCount} total
                {data.isWeekendPack ? " · weekend" : ""}
              </span>
            )}
            {newCount > 0 && (
              <span className="text-[10px] font-bold text-red-400 normal-case tracking-normal">
                · {newCount} new
              </span>
            )}
          </div>
          {data?.sessionLabel && (
            <p className="text-[9px] font-mono text-zinc-500 truncate">{data.sessionLabel}</p>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {summary && genTime && (
            <span className="text-[10px] text-amber-200/40 flex items-center gap-1 mr-1">
              <Clock className="w-3 h-3" />{genTime}
            </span>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={generating}
              title={summary ? "Regenerate Haiku from session pack" : "Generate Haiku summary"}
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-[#d4af37]/15 text-[#d4af37] border border-[#d4af37]/25 hover:bg-[#d4af37]/25 disabled:opacity-40"
            >
              {summary ? (
                <RefreshCw className={cn("w-3 h-3", generating && "animate-spin")} />
              ) : (
                <Sparkles className={cn("w-3 h-3", generating && "animate-spin")} />
              )}
              {generating ? "…" : summary ? "Refresh" : "Generate"}
            </button>
          )}
        </div>
      </div>

      <div className="px-2.5 py-2">
        {isLoading && !data && (
          <p className="text-[11px] text-amber-200/40">Loading…</p>
        )}
        {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}
        {feedbackMsg && <p className="text-[10px] text-emerald-400/80 mb-2">{feedbackMsg}</p>}
        {generating && !summary && (
          <p className="text-[11px] text-amber-200/50">Summarizing session desk emails…</p>
        )}
        {!generating && !summary && (data?.todayCount ?? 0) === 0 && (
          <p className="text-[11px] text-amber-200/40">
            No emails in {data?.sessionLabel ?? "this session"} yet. Label with{" "}
            <code className="text-[#d4af37]/70">tradedash-brief</code>.
          </p>
        )}
        {!generating && !summary && (data?.todayCount ?? 0) > 0 && (
          <p className="text-[11px] text-amber-200/50 mb-2">
            {data!.includedCount ?? data!.todayCount} emails ready for Haiku
            {(data!.excludedCount ?? 0) > 0 ? ` (${data!.excludedCount} filtered as noise)` : ""}.
          </p>
        )}
        {summary && (
          <div>
            {newCount > 0 && (
              <p className="text-[11px] font-semibold text-red-400 mb-2">
                {newCount} new since last summary — Refresh to update.
              </p>
            )}
            <div className="max-h-[280px] overflow-y-auto pr-1">
              {renderBrief(
                summary.content,
                isAdmin
                  ? (bullet) => {
                      const reason = window.prompt("Why is this not relevant?", "not actionable for CSP book");
                      if (reason == null) return;
                      void sendFeedback({ feedbackType: "not_relevant", bulletText: bullet, reason }).catch((e) =>
                        setError(String(e?.message ?? e)),
                      );
                    }
                  : undefined,
              )}
            </div>
            {summary.sources?.length > 0 && (
              <p className="mt-2 text-[10px] text-amber-200/30">
                Sources: {summary.sources.join(", ")}
                {" · "}
                {summary.includedCount ?? summary.emailCount} emails
              </p>
            )}
          </div>
        )}

        {isAdmin && (
          <div className="mt-2 flex items-center gap-1 border-t border-zinc-800 pt-2">
            <MessageCircleQuestion className="w-3 h-3 text-zinc-500 shrink-0" />
            <input
              value={askWhy}
              onChange={(e) => setAskWhy(e.target.value)}
              placeholder="Ask why it skipped an event…"
              className="flex-1 bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[11px] text-zinc-200 placeholder:text-zinc-600"
            />
            <button
              type="button"
              disabled={!askWhy.trim()}
              onClick={() => {
                const q = askWhy.trim();
                setAskWhy("");
                void sendFeedback({ feedbackType: "ask_why", question: q }).catch((e) =>
                  setError(String(e?.message ?? e)),
                );
              }}
              className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 hover:text-[#d4af37] disabled:opacity-40"
            >
              Ask
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
