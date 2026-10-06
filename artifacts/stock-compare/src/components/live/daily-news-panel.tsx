/**
 * Live → News → Daily News — visual briefing (chips + dig cards + scannable sections).
 * Research cue: "Quick update / Briefing" pattern — KPI strip → activity cards → short prose.
 */
import { useCallback, useMemo, useState, type ReactNode, Fragment } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Clock,
  MessageCircleQuestion,
  RefreshCw,
  Sparkles,
  Target,
  ThumbsDown,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { parseSections } from "./daily-news-parse";

interface DigFact {
  ticker: string;
  kind: string;
  detail: string;
  source: string;
  url?: string;
}

interface DailyNewsSummary {
  content: string;
  generatedAt: string;
  emailCount: number;
  includedCount?: number;
  maxReceivedAt: string | null;
  sources: string[];
  categories?: string[];
  sessionStartPt?: string;
  digFacts?: DigFact[];
  bookHits?: string[];
  earningsNear?: string;
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

interface MarketChip {
  ticker: string;
  price: number | null;
  changePercent: number | null;
}

async function fetchDailyNews(): Promise<DailyNewsResponse> {
  const r = await fetch("/api/desk-commentaries/daily-news", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

const RISK_RE = /\b(risk|risks|spike|vol|volatility|war|tariff|cut|cuts|hawkish|selloff|crash|default|recession|halt|ban)\b/gi;
const OPP_RE = /\b(bid|bids|support|bounce|calm|easing|dovish|premium|carry|opportunity|tailwind)\b/gi;
const NUM_RE = /(?:\$[\d,.]+(?:\s?(?:bn|mm|m|k|trillion|billion|million))?|\b\d+(?:\.\d+)?%|\b\d+(?:\.\d+)?\s?bps?\b|\b\d+(?:\.\d+)?\s?x\b)/gi;
const TICKER_RE = /\b([A-Z]{1,5})\b/g;
const TICKER_STOP = new Set([
  "A", "I", "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO", "IF", "IN", "IS", "IT",
  "ME", "MY", "NO", "OF", "OK", "ON", "OR", "SO", "TO", "UP", "US", "WE",
  "CEO", "CFO", "CTO", "CPI", "PPI", "GDP", "FED", "FOMC", "PCE", "NFP", "PMI",
  "ISM", "ETF", "IPO", "USD", "JPY", "EUR", "GBP", "OPEC", "NATO", "SEC", "FDA",
  "AI", "TV", "VS", "AND", "THE", "FOR", "BUT", "NOT", "ALL", "ANY",
  "PT", "ET", "EST", "PST", "UTC", "YOY", "QOQ", "MOM", "ATM", "OTM", "ITM",
  "CSP", "CC", "IV", "RV", "DTE", "APR", "YTD",
]);

type Frag = { kind: "text" | "bold" | "italic" | "ticker" | "num" | "risk" | "opp"; text: string };

function pushPlain(out: Frag[], text: string) {
  if (!text) return;
  let last = 0;
  const hits: Array<{ start: number; end: number; kind: Frag["kind"] }> = [];
  for (const m of text.matchAll(NUM_RE)) {
    if (m.index == null) continue;
    hits.push({ start: m.index, end: m.index + m[0].length, kind: "num" });
  }
  hits.sort((a, b) => a.start - b.start);
  const merged: typeof hits = [];
  for (const h of hits) {
    const prev = merged[merged.length - 1];
    if (prev && h.start < prev.end) continue;
    merged.push(h);
  }
  if (merged.length === 0) {
    colorWords(out, text);
    return;
  }
  for (const h of merged) {
    if (h.start > last) colorWords(out, text.slice(last, h.start));
    out.push({ kind: h.kind, text: text.slice(h.start, h.end) });
    last = h.end;
  }
  if (last < text.length) colorWords(out, text.slice(last));
}

function colorWords(out: Frag[], text: string) {
  const re = new RegExp(`${RISK_RE.source}|${OPP_RE.source}`, "gi");
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index == null) continue;
    if (m.index > last) tickerize(out, text.slice(last, m.index));
    const word = m[0];
    const isRisk = RISK_RE.test(word);
    RISK_RE.lastIndex = 0;
    out.push({ kind: isRisk ? "risk" : "opp", text: word });
    last = m.index + word.length;
  }
  if (last < text.length) tickerize(out, text.slice(last));
}

function tickerize(out: Frag[], text: string) {
  let last = 0;
  for (const m of text.matchAll(TICKER_RE)) {
    if (m.index == null) continue;
    const sym = m[1]!;
    if (TICKER_STOP.has(sym)) continue;
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push({ kind: "ticker", text: sym });
    last = m.index + sym.length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
}

function parseInline(raw: string): Frag[] {
  const out: Frag[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  for (const m of raw.matchAll(re)) {
    if (m.index == null) continue;
    if (m.index > last) pushPlain(out, raw.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      const inner = tok.slice(2, -2);
      const nested: Frag[] = [];
      pushPlain(nested, inner);
      if (nested.length === 1 && nested[0]!.kind === "text") out.push({ kind: "bold", text: inner });
      else for (const n of nested) out.push(n.kind === "text" ? { kind: "bold", text: n.text } : n);
    } else {
      out.push({ kind: "italic", text: tok.slice(1, -1) });
    }
    last = m.index + tok.length;
  }
  if (last < raw.length) pushPlain(out, raw.slice(last));
  return out;
}

function renderFrags(frags: Frag[]): ReactNode[] {
  return frags.map((f, i) => {
    switch (f.kind) {
      case "bold":
        return <strong key={i} className="font-semibold text-amber-50">{f.text}</strong>;
      case "italic":
        return <em key={i} className="italic text-amber-100/55">{f.text}</em>;
      case "ticker":
        return (
          <span key={i} className="font-mono font-bold text-[#d4af37] underline decoration-[#d4af37]/35 underline-offset-2">
            {f.text}
          </span>
        );
      case "num":
        return <span key={i} className="font-mono tabular-nums text-sky-300/90">{f.text}</span>;
      case "risk":
        return <span key={i} className="font-medium text-rose-300/85">{f.text}</span>;
      case "opp":
        return <span key={i} className="font-medium text-emerald-300/80">{f.text}</span>;
      default:
        return <span key={i}>{f.text}</span>;
    }
  });
}

const SECTION_META: Record<string, { tone: string; icon: "macro" | "cross" | "sector" | "take" }> = {
  "overnight / macro": { tone: "border-sky-500/45 bg-sky-950/20", icon: "macro" },
  "cross-asset / politics": { tone: "border-violet-400/40 bg-violet-950/15", icon: "cross" },
  "sector & tickers": { tone: "border-[#d4af37]/45 bg-[#d4af37]/5", icon: "sector" },
  "put-seller takeaway": { tone: "border-emerald-500/45 bg-emerald-950/20", icon: "take" },
};

function sectionMeta(title: string) {
  const key = title.trim().toLowerCase().replace(/\s*\(.*\)\s*$/, "");
  for (const [k, v] of Object.entries(SECTION_META)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return { tone: "border-[#d4af37]/30 bg-zinc-900/40", icon: "macro" as const };
}

function digKindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

function digKindClass(kind: string): string {
  if (kind.includes("upgrade") || kind.includes("price")) return "text-emerald-300 border-emerald-500/30 bg-emerald-950/30";
  if (kind.includes("downgrade")) return "text-rose-300 border-rose-500/30 bg-rose-950/30";
  return "text-sky-300 border-sky-500/30 bg-sky-950/30";
}

function fmtChg(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const pct = Math.abs(n) <= 1 ? n * 100 : n;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
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

  const { data: tape } = useQuery({
    queryKey: ["live-state"],
    queryFn: async (): Promise<{ marketContext: MarketChip[] }> => {
      const r = await fetch("/api/live/state", { credentials: "include" });
      if (!r.ok) throw new Error("live/state failed");
      return r.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
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

  const sections = useMemo(
    () => (summary?.content ? parseSections(summary.content) : []),
    [summary?.content],
  );
  // Drop TipRanks count-teasers + prose false positives (TO/GOT) if an old cache slips through.
  const digFacts = (summary?.digFacts ?? []).filter(
    (f) =>
      f.ticker.length >= 1 &&
      !/^(TO|GOT|FOR|THE|AND|NEW|ALL)$/i.test(f.ticker) &&
      !/^\d+\s+new analyst rating/i.test(f.detail),
  );
  const earningsBits = (summary?.earningsNear ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("("));

  const chips = (tape?.marketContext ?? []).filter((c) =>
    ["SPY", "QQQ", "^VIX", "^TNX"].includes(c.ticker),
  );

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
              title={summary ? "Regenerate with dig + book ranking" : "Generate Haiku summary"}
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

      <div className="px-3 py-2.5 space-y-3">
        {/* Tape strip — one compact line */}
        {chips.length > 0 && (
          <div className="flex flex-nowrap items-center gap-x-3 overflow-x-auto whitespace-nowrap text-[11px] font-mono tabular-nums">
            {chips.map((c, i) => {
              const up = (c.changePercent ?? 0) >= 0;
              const label = c.ticker.replace("^", "");
              return (
                <Fragment key={c.ticker}>
                  {i > 0 && <span className="text-zinc-700 select-none" aria-hidden>·</span>}
                  <span className="inline-flex items-baseline gap-1.5 shrink-0">
                    <span className="text-[9px] uppercase tracking-wide text-zinc-500">{label}</span>
                    <span className="text-amber-50/90">
                      {c.price != null ? c.price.toFixed(2) : "—"}
                    </span>
                    <span className={cn(up ? "text-emerald-400/90" : "text-rose-400/90")}>
                      {fmtChg(c.changePercent)}
                    </span>
                  </span>
                </Fragment>
              );
            })}
          </div>
        )}

        {isLoading && !data && (
          <p className="text-[11px] text-amber-200/40">Loading…</p>
        )}
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {feedbackMsg && <p className="text-[10px] text-emerald-400/80">{feedbackMsg}</p>}
        {generating && !summary && (
          <p className="text-[11px] text-amber-200/50">Digging links + summarizing session…</p>
        )}
        {!generating && !summary && (data?.todayCount ?? 0) === 0 && (
          <p className="text-[11px] text-amber-200/40">
            No emails in {data?.sessionLabel ?? "this session"} yet. Label with{" "}
            <code className="text-[#d4af37]/70">tradedash-brief</code>.
          </p>
        )}
        {!generating && !summary && (data?.todayCount ?? 0) > 0 && (
          <p className="text-[11px] text-amber-200/50">
            {data!.includedCount ?? data!.todayCount} emails ready
            {(data!.excludedCount ?? 0) > 0 ? ` (${data!.excludedCount} noise)` : ""}.
          </p>
        )}

        {summary && (
          <div className="min-h-[360px] max-h-[min(72vh,780px)] overflow-y-auto pr-1 space-y-3">
            {newCount > 0 && (
              <p className="text-[11px] font-semibold text-red-400">
                {newCount} new since last summary — Refresh to update.
              </p>
            )}

            {/* Dig activity cards — structured facts, not prose */}
            {digFacts.length > 0 && (
              <div className="rounded-md border border-sky-500/25 bg-sky-950/15 p-2">
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-sky-300/90 mb-1.5">
                  <Activity className="w-3 h-3" />
                  Desk dig · ratings / targets
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {digFacts.slice(0, 12).map((f, i) => (
                    <div
                      key={`${f.ticker}-${f.kind}-${i}`}
                      className={cn(
                        "inline-flex items-center gap-1.5 rounded border px-1.5 py-1 text-[11px]",
                        digKindClass(f.kind),
                      )}
                      title={f.source}
                    >
                      <span className="font-mono font-bold">{f.ticker}</span>
                      <span className="text-[9px] uppercase opacity-70">{digKindLabel(f.kind)}</span>
                      <span className="text-amber-50/80 max-w-[140px] truncate">{f.detail}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Earnings near book */}
            {earningsBits.length > 0 && (
              <div className="rounded-md border border-[#d4af37]/20 bg-zinc-900/50 px-2 py-1.5">
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#d4af37]/90 mb-1">
                  <Target className="w-3 h-3" />
                  Book earnings · 14d
                </div>
                <div className="flex flex-wrap gap-1">
                  {earningsBits.map((e) => (
                    <span
                      key={e}
                      className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-zinc-950 border border-[#d4af37]/25 text-amber-100/80"
                    >
                      {e}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Narrative sections as cards */}
            {sections.length > 0 ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {sections.map((sec) => {
                  const meta = sectionMeta(sec.title);
                  return (
                    <div
                      key={sec.title}
                      className={cn("rounded-md border p-2.5", meta.tone, sec.title.toLowerCase().includes("takeaway") && "sm:col-span-2")}
                    >
                      <div className="flex items-center gap-1.5 mb-1.5">
                        <TrendingUp className="w-3 h-3 opacity-70" />
                        <h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-amber-50/90">
                          {sec.title}
                        </h3>
                      </div>
                      <ul className="space-y-1.5">
                        {sec.bullets.map((b, i) => (
                          <li key={i} className="group flex items-start gap-1.5">
                            <span className="mt-[6px] w-1 h-1 rounded-full bg-current opacity-40 shrink-0" />
                            <p className="flex-1 text-[12px] text-amber-50/80 leading-[1.35]">
                              {renderFrags(parseInline(b))}
                            </p>
                            {isAdmin && (
                              <button
                                type="button"
                                title="Not relevant"
                                onClick={() => {
                                  const reason = window.prompt("Why is this not relevant?", "not actionable for CSP book");
                                  if (reason == null) return;
                                  void sendFeedback({ feedbackType: "not_relevant", bulletText: b, reason }).catch((e) =>
                                    setError(String(e?.message ?? e)),
                                  );
                                }}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-600 hover:text-red-400"
                              >
                                <ThumbsDown className="w-3 h-3" />
                              </button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-[12px] text-amber-50/80 space-y-1">
                {summary.content.split("\n").map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            )}

            {summary.sources?.length > 0 && (
              <p className="text-[10px] text-amber-200/30 tracking-wide">
                Sources: {summary.sources.join(" · ")}
                {" · "}
                {summary.includedCount ?? summary.emailCount} emails
                {summary.bookHits?.length ? ` · book dig: ${summary.bookHits.join(", ")}` : ""}
              </p>
            )}
          </div>
        )}

        {isAdmin && (
          <div className="flex items-center gap-1 border-t border-zinc-800 pt-2">
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
