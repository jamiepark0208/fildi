/**
 * Live → News → Daily News — visual briefing (chips + dig cards + scannable sections).
 * Research cue: "Quick update / Briefing" pattern — KPI strip → activity cards → short prose.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
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
import { formatMdYy } from "@/lib/format";
import { VERDICT_COLORS, VERDICT_LABELS } from "@/hooks/use-model-list";
import { parseSections } from "./daily-news-parse";

interface DigFact {
  ticker: string;
  kind: string;
  detail: string;
  source: string;
  url?: string;
}

interface EarningsNearRow {
  date: string;
  tickers: string[];
}

interface ModelContractRow {
  ticker: string;
  side: string;
  strike: number | null;
  expiry: string | null;
  premium: number | null;
  folder: string;
  verdict: string;
  status: string;
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
  earningsNearRows?: EarningsNearRow[];
  marketEarningsRows?: EarningsNearRow[];
  modelContracts?: ModelContractRow[];
}

interface MuseBrief {
  edition: "am" | "pm";
  file: string;
  title: string;
  banner: string;
  bullets: string[];
  asOfYmd?: string | null;
  contentHash?: string;
  stale?: boolean;
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
  statusLine?: string;
  editionId?: string | null;
  materialSuggested?: boolean;
  materialReasons?: string[];
  skipped?: boolean;
  summary: DailyNewsSummary | null;
  earningsNearRows?: EarningsNearRow[];
  marketEarningsRows?: EarningsNearRow[];
  modelContracts?: ModelContractRow[];
  museBrief?: MuseBrief | null;
  /** Prior-day brief when today's isn't ready yet (A62) — status line carries the signal */
  museBriefStale?: MuseBrief | null;
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
const SECTOR_RE =
  /\b(Technology|Tech|Semiconductors?|Chips?|Banks?|Financials?|Energy|Oil|Healthcare|Biotech|Consumer|Retail|Industrials?|Utilities|Materials?|Metals?|Crypto|Software|Mag\s*7|Megacaps?|Autos?|Airlines?)\b/gi;
/** Signed %/bps/levels — leading +/- and commas so overnight lines don't fragment on - / &. */
const NUM_RE =
  /(?:\$[\d,.]+(?:\s?(?:bn|mm|m|k|trillion|billion|million))?|[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|[+-]?\d+(?:\.\d+)?%|[+-]?\d+(?:\.\d+)?\s?bps?\b|[+-]?\d+(?:\.\d+)?\s?x\b)/gi;
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

type Frag =
  | { kind: "text" | "bold" | "italic" | "ticker" | "num" | "risk" | "opp" | "sector" | "bull" | "bear" | "neut"; text: string };

/** Rewrite ISO YYYY-MM-DD inside free text to m/d/yy; soften em-dashes that break scanning. */
function displayDatesInText(text: string): string {
  return text
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => formatMdYy(`${y}-${m}-${d}`))
    .replace(/\s*[—–]\s*/g, " · ");
}

/** Sort dig chips: largest upgrades → largest downgrades. */
function digSortScore(f: DigFact): number {
  const d = f.detail;
  let delta = 0;
  const arrow = d.match(/\$([\d,.]+)\s*[→\-–to]+\s*\$?([\d,.]+)/i);
  if (arrow) {
    delta = parseFloat(arrow[2]!.replace(/,/g, "")) - parseFloat(arrow[1]!.replace(/,/g, ""));
  } else {
    const pct = d.match(/([+-]?\d+(?:\.\d+)?)\s*%/);
    if (pct) delta = parseFloat(pct[1]!);
  }
  if (f.kind.includes("upgrade")) return 1000 + delta;
  if (f.kind === "price_target" && (/rais|lift|increas|\+/i.test(d) || delta > 0)) return 500 + Math.abs(delta);
  if (f.kind === "price_target" && (/cut|lower|reduc|slash/i.test(d) || delta < 0)) return -500 - Math.abs(delta);
  if (f.kind.includes("downgrade")) return -1000 + delta;
  if (f.kind === "analyst_rating" && /buy|overweight|outperform/i.test(d)) return 100;
  if (f.kind === "analyst_rating" && /sell|underweight|underperform/i.test(d)) return -100;
  return 0;
}

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
  const re = new RegExp(
    `${BULL_WORD.source}|${BEAR_WORD.source}|${NEUT_WORD.source}|${RISK_RE.source}|${OPP_RE.source}|${SECTOR_RE.source}`,
    "gi",
  );
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index == null) continue;
    if (m.index > last) tickerize(out, text.slice(last, m.index));
    const word = m[0];
    BULL_WORD.lastIndex = BEAR_WORD.lastIndex = NEUT_WORD.lastIndex = 0;
    RISK_RE.lastIndex = OPP_RE.lastIndex = SECTOR_RE.lastIndex = 0;
    let kind: Frag["kind"] = "sector";
    if (BULL_WORD.test(word)) kind = "bull";
    else if (BEAR_WORD.test(word)) kind = "bear";
    else if (NEUT_WORD.test(word)) kind = "neut";
    else if (RISK_RE.test(word)) kind = "risk";
    else if (OPP_RE.test(word)) kind = "opp";
    BULL_WORD.lastIndex = BEAR_WORD.lastIndex = NEUT_WORD.lastIndex = 0;
    RISK_RE.lastIndex = OPP_RE.lastIndex = 0;
    out.push({ kind, text: word });
    last = m.index + word.length;
  }
  if (last < text.length) tickerize(out, text.slice(last));
}

function tickerizeChunk(out: Frag[], text: string) {
  // letter&letter → keep amp (naive ticker split would break on &).
  const protected_ = text.replace(/([A-Za-z])&([A-Za-z])/g, "$1\uE002$2");
  let last = 0;
  for (const m of protected_.matchAll(TICKER_RE)) {
    if (m.index == null) continue;
    const sym = m[1]!;
    if (TICKER_STOP.has(sym)) continue;
    if (m.index > last) {
      out.push({ kind: "text", text: protected_.slice(last, m.index).replace(/\uE002/g, "&") });
    }
    out.push({ kind: "ticker", text: sym });
    last = m.index + sym.length;
  }
  if (last < protected_.length) {
    out.push({ kind: "text", text: protected_.slice(last).replace(/\uE002/g, "&") });
  }
}

function tickerize(out: Frag[], text: string) {
  // Keep "S&P" intact as one ticker token.
  const parts = text.split(/(S&P)/gi);
  for (const part of parts) {
    if (!part) continue;
    if (/^S&P$/i.test(part)) out.push({ kind: "ticker", text: "S&P" });
    else tickerizeChunk(out, part);
  }
}

function parseInline(raw: string): Frag[] {
  const out: Frag[] = [];
  raw = displayDatesInText(raw);
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
      case "sector":
        return (
          <span key={i} className="font-semibold text-violet-300/90 underline decoration-violet-400/40 underline-offset-2">
            {f.text}
          </span>
        );
      case "bull":
        return <span key={i} className="font-semibold text-emerald-400">{f.text}</span>;
      case "bear":
        return <span key={i} className="font-semibold text-rose-400">{f.text}</span>;
      case "neut":
        return <span key={i} className="font-semibold text-amber-300">{f.text}</span>;
      default:
        return <span key={i}>{f.text}</span>;
    }
  });
}

/** Orange header border, dark fill — never wash text in same hue as the box. */
const CARD_TONE = "border-[#d4af37]/40 bg-zinc-950";

function sectionMeta(_title: string) {
  return { tone: CARD_TONE };
}

function digKindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

function digKindClass(kind: string): string {
  if (kind.includes("upgrade") || kind.includes("price")) {
    return "text-emerald-300 border-[#d4af37]/35 bg-zinc-950";
  }
  if (kind.includes("downgrade")) return "text-rose-300 border-[#d4af37]/35 bg-zinc-950";
  return "text-amber-50/85 border-[#d4af37]/35 bg-zinc-950";
}

const BULL_WORD =
  /\b(upgraded?|upgrade|raised?|overweight|outperform|strong buy|buy|beat|initiates?)\b/gi;
const BEAR_WORD =
  /\b(downgraded?|downgrade|cut|lowered?|underweight|underperform|strong sell|sell|miss(?:ed)?|slashed?)\b/gi;
const NEUT_WORD = /\b(maintain(?:s|ed)?|reiterate[ds]?|hold|neutral|equal[-\s]?weight|market perform)\b/gi;

/** Tape % → whole number; flat → "-". */
function fmtTapePct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  const pct = Math.abs(n) <= 1 ? n * 100 : n;
  const r = Math.round(pct);
  if (r === 0) return "-";
  return `${r > 0 ? "+" : ""}${r}%`;
}

function roundPctToken(raw: string): string {
  const n = parseFloat(raw.replace(/[\u2212\u2013]/g, "-").replace(/%/g, ""));
  if (!Number.isFinite(n)) return "-";
  const r = Math.round(n);
  if (r === 0) return "-";
  return `${r > 0 ? "+" : ""}${r}%`;
}

type TapeRow = { key: string; label: string; value: string; up: boolean | null; title?: string };

/** Muse banner → same chip shape as Yahoo tape (label + % / level). */
function parseBannerTape(banner: string): TapeRow[] {
  const parts = banner
    .split(/\s*[·|]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: TapeRow[] = [];
  for (const part of parts) {
    const is10y = /\b10\s*y|\b10yr|\btnx\b/i.test(part);
    const pct = part.match(/([+\u2212\u2013\-]\s*\d+(?:\.\d+)?\s*%)/);
    const unch = /\(~?unch\)|unchanged/i.test(part);
    let label = part;
    let value = "";
    let up: boolean | null = null;
    if (is10y) {
      // Keep actual yield (not day-change %).
      const lvl = part.match(/(\d+\.\d+)\s*%?/);
      label = "10Y";
      value = lvl ? `${lvl[1]}%` : "-";
      up = null;
    } else if (pct) {
      value = roundPctToken(pct[1]!);
      label = part.slice(0, pct.index).trim().replace(/[(\[]\s*$/, "").trim();
      // Drop trailing level noise before the signed % (e.g. "Brent $102.9")
      label = label.replace(/\s*\$?[\d,.]+$/, "").trim() || label;
      up = value === "-" ? null : value.startsWith("-") ? false : true;
    } else if (unch) {
      value = "-";
      label = part.replace(/\s*\(~?unch\)/i, "").trim();
      up = null;
    } else {
      const lvl = part.match(/^(.+?)\s+(\$?[\d,.]+%?(?:\s*\([^)]+\))?)\s*$/);
      if (lvl) {
        label = lvl[1]!.trim();
        value = lvl[2]!.trim();
      } else {
        label = part;
      }
    }
    label = label
      .replace(/^S&P\s*fut(?:ures)?$/i, "ES")
      .replace(/^Dow\s*fut(?:ures)?$/i, "YM")
      .replace(/^Nasdaq(?:\s*100)?\s*fut(?:ures)?$/i, "NQ")
      .replace(/^Brent\b.*/i, "Brent")
      .replace(/^VIX\b.*/i, "VIX");
    if (!label) continue;
    const key = label.toLowerCase();
    out.push({ key, label, value: value || "-", up, title: part });
  }
  return out;
}

const YAHOO_TAPE_ORDER = ["SPY", "QQQ", "^VIX", "^TNX"] as const;

export function DailyNewsPanel({ compact = false }: { compact?: boolean }) {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [askWhy, setAskWhy] = useState("");
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null);
  /** After a materiality skip, next Regen click forces Haiku. */
  const [forceNext, setForceNext] = useState(false);

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

  const refresh = useCallback(async (opts?: { force?: boolean }) => {
    const force = opts?.force === true || forceNext;
    setGenerating(true);
    setError(null);
    setFeedbackMsg(null);
    try {
      const r = await fetch("/api/desk-commentaries/daily-news/refresh", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      const next = (await r.json()) as DailyNewsResponse;
      queryClient.setQueryData(["desk-daily-news"], next);
      queryClient.invalidateQueries({ queryKey: ["desk-session"] });
      if (next.skipped) {
        setForceNext(true);
        setFeedbackMsg(next.message ?? next.statusLine ?? "No material update — click Regen again to force.");
      } else {
        setForceNext(false);
        if (force) setFeedbackMsg("Forced Desk adds refresh.");
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to generate");
    } finally {
      setGenerating(false);
    }
  }, [queryClient, forceNext]);

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
  const digFacts = useMemo(() => {
    return (summary?.digFacts ?? [])
      .filter(
        (f) =>
          f.ticker.length >= 1 &&
          !/^(TO|GOT|FOR|THE|AND|NEW|ALL|DA)$/i.test(f.ticker) &&
          !/^\d+\s+new analyst rating/i.test(f.detail),
      )
      .slice()
      .sort((a, b) => digSortScore(b) - digSortScore(a));
  }, [summary?.digFacts]);

  const marketEarningsRows: EarningsNearRow[] =
    data?.marketEarningsRows ?? summary?.marketEarningsRows ?? [];

  const earningsRows: EarningsNearRow[] = useMemo(() => {
    const live = data?.earningsNearRows ?? summary?.earningsNearRows;
    if (live?.length) return live;
    // Legacy string: "NFLX 2026-10-20, ALOY 2026-10-14" or "2026-10-20: NFLX, TSLA"
    const raw = summary?.earningsNear ?? "";
    if (!raw || raw.startsWith("(")) return [];
    const byDate = new Map<string, string[]>();
    const add = (date: string, ticker: string) => {
      const t = ticker.toUpperCase();
      if (!/^[A-Z]{1,5}$/.test(t)) return;
      const list = byDate.get(date) ?? [];
      if (!list.includes(t)) list.push(t);
      byDate.set(date, list);
    };
    for (const chunk of raw.split(";")) {
      const grouped = chunk.trim().match(/^(\d{4}-\d{2}-\d{2}):\s*(.+)$/);
      if (grouped) {
        for (const t of grouped[2]!.split(/[,\s]+/)) add(grouped[1]!, t);
        continue;
      }
      for (const part of chunk.split(",")) {
        const one = part.trim().match(/^([A-Z]{1,5})\s+(\d{4}-\d{2}-\d{2})$/i);
        if (one) add(one[2]!, one[1]!);
      }
    }
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, tickers]) => ({ date, tickers: tickers.sort() }));
  }, [data?.earningsNearRows, summary?.earningsNearRows, summary?.earningsNear]);

  const modelContracts = data?.modelContracts ?? summary?.modelContracts ?? [];
  const museBrief = data?.museBrief ?? null;

  const yahooTape: TapeRow[] = useMemo(() => {
    const by = new Map((tape?.marketContext ?? []).map((c) => [c.ticker, c]));
    return YAHOO_TAPE_ORDER.flatMap((t) => {
      const c = by.get(t);
      if (!c) return [];
      // TNX: show actual yield; others: whole-number 1d %.
      if (t === "^TNX") {
        const y = c.price != null && Number.isFinite(c.price) ? `${c.price.toFixed(2)}%` : "-";
        return [{
          key: t,
          label: "10Y",
          value: y,
          up: null,
          title: "10Y treasury yield",
        }];
      }
      const up = c.changePercent == null ? null : c.changePercent >= 0;
      const value = fmtTapePct(c.changePercent);
      return [{
        key: t,
        label: t.replace("^", ""),
        value,
        up: value === "-" ? null : up,
        title: `${t.replace("^", "")} session 1d change`,
      }];
    });
  }, [tape?.marketContext]);

  const bannerTape: TapeRow[] = useMemo(() => {
    if (!museBrief?.banner) return [];
    const rows = parseBannerTape(museBrief.banner);
    // Drop banner rows already covered by Yahoo tape (VIX / 10Y≈TNX)
    const skip = new Set<string>();
    if (yahooTape.some((r) => r.key === "^VIX")) skip.add("vix");
    if (yahooTape.some((r) => r.key === "^TNX")) {
      skip.add("10y");
      skip.add("10yr");
      skip.add("ust 10y");
    }
    return rows.filter((r) => !skip.has(r.key) && !r.key.startsWith("vix"));
  }, [museBrief?.banner, yahooTape]);

  const liveTape = useMemo(() => [...yahooTape, ...bannerTape], [yahooTape, bannerTape]);

  const sectionByKey = useMemo(() => {
    const map = new Map<string, { title: string; bullets: string[] }>();
    for (const sec of sections) {
      const k = sec.title.trim().toLowerCase();
      if (k.includes("desk add") || k.includes("overnight") || k.includes("macro") || k.includes("cross")) {
        const prev = map.get("adds");
        map.set("adds", prev
          ? { title: "Desk adds", bullets: [...prev.bullets, ...sec.bullets] }
          : { title: k.includes("desk") ? sec.title : "Desk adds", bullets: sec.bullets });
      } else if (k.includes("sector") || k.includes("ticker")) map.set("sector", sec);
      else if (k.includes("takeaway") || k.includes("put-seller")) map.set("take", sec);
      else map.set(k, sec);
    }
    return map;
  }, [sections]);

  /** Book + market majors, one list sorted by date. */
  const earningsMerged = useMemo(() => {
    const byDate = new Map<string, Array<{ ticker: string; book: boolean }>>();
    const add = (date: string, ticker: string, book: boolean) => {
      const list = byDate.get(date) ?? [];
      if (!list.some((x) => x.ticker === ticker)) list.push({ ticker, book });
      byDate.set(date, list);
    };
    for (const row of earningsRows) for (const t of row.tickers) add(row.date, t, true);
    for (const row of marketEarningsRows) for (const t of row.tickers) add(row.date, t, false);
    return [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, tickers]) => ({
        date,
        tickers: tickers.sort((a, b) => a.ticker.localeCompare(b.ticker)),
      }));
  }, [earningsRows, marketEarningsRows]);

  const digSourceTitle = (sources: string[]) =>
    [...new Set(sources)].join(" · ") || "desk dig";

  const renderSectionCard = (
    sec: { title: string; bullets: string[] } | undefined,
    opts?: { className?: string; span2?: boolean; sourceHint?: string },
  ) => {
    if (!sec) return null;
    const meta = sectionMeta(sec.title);
    return (
      <div
        className={cn(
          "rounded-md border p-2.5",
          meta.tone,
          opts?.span2 && "sm:col-span-2",
          opts?.className,
        )}
      >
        <div className="flex items-center gap-1.5 mb-1.5">
          <TrendingUp className="w-3 h-3 text-[#d4af37]/80" />
          <h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#d4af37]">
            {sec.title}
          </h3>
        </div>
        <ul className="space-y-1.5">
          {sec.bullets.map((b, i) => (
            <li key={i} className="group flex items-start gap-1.5" title={opts?.sourceHint ?? digSourceTitle(summary?.sources ?? [])}>
              <span className="mt-[6px] w-1 h-1 rounded-full bg-[#d4af37]/50 shrink-0" />
              <p className="flex-1 text-[12px] text-amber-50/90 leading-[1.35]">
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
  };

  const modelContractsCard = modelContracts.length > 0 ? (
    <div className={cn("rounded-md border p-2.5", CARD_TONE)}>
      <div className="flex items-center gap-1.5 mb-1.5">
        <TrendingUp className="w-3 h-3 text-[#d4af37]/80" />
        <h3 className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#d4af37]">
          Model contracts
        </h3>
      </div>
      <ul className="space-y-1.5">
        {modelContracts.map((c) => {
          const tip = [c.folder, c.verdict ? (VERDICT_LABELS[c.verdict] ?? c.verdict) : "", c.status]
            .filter(Boolean)
            .join(" · ");
          const color = VERDICT_COLORS[c.verdict] ?? "#d4af37";
          return (
            <li key={`${c.ticker}-${c.folder}`} className="text-[12px] leading-snug text-amber-50/90">
              <span
                className="font-mono font-bold underline decoration-current/30 underline-offset-2"
                style={{ color }}
                title={tip}
              >
                {c.ticker}
              </span>
              {": sell "}
              <span className={c.side === "put" ? "text-emerald-400" : "text-sky-300"}>{c.side}</span>
              {" "}
              <span className="font-mono tabular-nums text-sky-300/90">
                {c.strike != null ? `$${c.strike}` : "?"}
              </span>
              {" exp "}
              <span className="font-mono tabular-nums">{formatMdYy(c.expiry)}</span>
              {c.premium != null && Number.isFinite(c.premium) && (
                <span className="font-mono tabular-nums text-emerald-400">
                  {" @ $"}
                  {c.premium}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  ) : null;

  const headerDate = data?.date ? formatMdYy(data.date) : null;

  return (
    <div className={cn(
      "rounded-md border border-[#d4af37]/25 bg-zinc-950 overflow-hidden",
      !compact && "shadow-lg shadow-black/60",
    )}>
      <div className="px-2.5 py-1.5 flex items-center justify-between border-b border-[#d4af37]/15 gap-2">
        <div className="min-w-0 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#d4af37]">
          <Sparkles className="w-3 h-3 shrink-0" />
          Daily News
          {headerDate && (
            <span className="text-[10px] font-mono font-normal text-white normal-case tracking-normal">
              · {headerDate}
            </span>
          )}
          {newCount > 0 && (
            <span className="text-[10px] font-bold text-red-400 normal-case tracking-normal">
              · {newCount} new
            </span>
          )}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {summary && genTime && (
            <span className="text-[10px] text-white/80 flex items-center gap-1 mr-1">
              <Clock className="w-3 h-3" />{genTime}
            </span>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={(e) => void refresh({ force: e.shiftKey || forceNext })}
              disabled={generating}
              title={
                forceNext
                  ? "Force Desk adds (materiality skipped last click)"
                  : summary
                    ? "Regen if material (Shift+click to force) — Muse/earnings/contracts refresh on page load"
                    : "Generate Desk adds from dig + emails"
              }
              className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold bg-[#d4af37]/15 text-[#d4af37] border border-[#d4af37]/25 hover:bg-[#d4af37]/25 disabled:opacity-40"
            >
              {summary ? (
                <RefreshCw className={cn("w-3 h-3", generating && "animate-spin")} />
              ) : (
                <Sparkles className={cn("w-3 h-3", generating && "animate-spin")} />
              )}
              {generating ? "…" : forceNext ? "Force" : summary ? "Regen" : "Generate"}
            </button>
          )}
        </div>
      </div>

      {data?.statusLine && (
        <p className="px-2.5 py-1 text-[10px] font-mono text-white/75 border-b border-[#d4af37]/10 truncate" title={data.statusLine}>
          {data.statusLine}
        </p>
      )}

      <div className="px-3 py-2.5 space-y-3">
        {/* Compact tape: SPY QQQ VIX 10Y then ES YM NQ … — one space between names */}
        {liveTape.length > 0 && (
          <div className="rounded-md border border-[#d4af37]/35 bg-zinc-950 px-1.5 py-0.5 flex flex-nowrap items-baseline gap-x-1 overflow-hidden whitespace-nowrap text-[10px] font-mono tabular-nums">
            {liveTape.map((row, i) => (
              <span key={`${row.key}-${i}`} className="inline-flex items-baseline gap-px shrink-0" title={row.title ?? row.label}>
                <span className="text-white/75">{row.label}</span>
                <span
                  className={cn(
                    row.up === true && "text-emerald-400",
                    row.up === false && "text-rose-400",
                    row.up == null && "text-amber-50/90",
                  )}
                >
                  {row.value}
                </span>
              </span>
            ))}
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

        {(summary || earningsRows.length > 0 || marketEarningsRows.length > 0 || modelContracts.length > 0 || museBrief) && (
          <div className="min-h-[360px] max-h-[min(72vh,780px)] overflow-y-auto pr-1 space-y-3">
            {summary && data?.materialSuggested && newCount > 0 && (
              <p className="text-[11px] font-semibold text-red-400">
                Material update ready — Regen for Desk adds
                {data.materialReasons?.length ? ` (${data.materialReasons.slice(0, 2).join(", ")})` : ""}.
              </p>
            )}

            {/* Muse English brief — bullets only (levels live in LIVE strip) */}
            {museBrief && museBrief.bullets.length > 0 && (
              <div className={cn("rounded-md border p-2.5", CARD_TONE)}>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#d4af37]">
                    <Sparkles className="w-3 h-3" />
                    {museBrief.edition === "am" ? "Morning brief" : "Evening recap"}
                  </div>
                  <span
                    className="text-[9px] font-mono text-white truncate"
                    title={museBrief.title}
                  >
                    {museBrief.asOfYmd
                      ? `as of ${Number(museBrief.asOfYmd.slice(5, 7))}/${Number(museBrief.asOfYmd.slice(8, 10))}`
                      : museBrief.file}
                  </span>
                </div>
                <ul className="space-y-1">
                  {museBrief.bullets.map((b, i) => (
                    <li key={i} className="flex items-start gap-1.5 text-[12px] text-amber-50/90 leading-[1.35]">
                      <span className="mt-[6px] w-1 h-1 rounded-full bg-[#d4af37]/50 shrink-0" />
                      <span>{renderFrags(parseInline(b))}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!museBrief && data?.museBriefStale && (
              <div className={cn("rounded-md border border-amber-500/30 p-2.5", CARD_TONE)}>
                <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-amber-300">
                  <Sparkles className="w-3 h-3" />
                  No brief yet today
                </div>
                <p className="mt-1 text-[11px] text-white/85">
                  Last Muse {data.museBriefStale.edition.toUpperCase()}
                  {data.museBriefStale.asOfYmd
                    ? ` · ${Number(data.museBriefStale.asOfYmd.slice(5, 7))}/${Number(data.museBriefStale.asOfYmd.slice(8, 10))}`
                    : ""}{" "}
                  is from a prior session — waiting for today’s brief.
                </p>
              </div>
            )}

            {/* Dig — source on hover (title), not a grey column */}
            {digFacts.length > 0 && (
              <div className={cn("rounded-md border p-2", CARD_TONE)}>
                <div className="flex items-center gap-1.5 mb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-[#d4af37]">
                  <Activity className="w-3 h-3" />
                  Desk dig
                </div>
                <ul className="space-y-1.5">
                  {digFacts.slice(0, 24).map((f, i) => {
                    const src = f.source.replace(/^analyst_events:/, "").replace(/_/g, " ");
                    return (
                      <li
                        key={`${f.ticker}-${f.kind}-${i}`}
                        title={src}
                        className={cn(
                          "flex items-start gap-2 rounded border px-2 py-1.5 text-[11px] leading-snug cursor-default",
                          digKindClass(f.kind),
                        )}
                      >
                        <span className="font-mono font-bold shrink-0 text-[#d4af37]">{f.ticker}</span>
                        <span className="text-[9px] uppercase text-white/70 shrink-0 pt-0.5">{digKindLabel(f.kind)}</span>
                        <span className="text-amber-50/90 min-w-0 flex-1 break-words">
                          {renderFrags(parseInline(f.detail))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* One earnings list — book gold, majors violet; sorted by date */}
            {earningsMerged.length > 0 && (
              <div className={cn("rounded-md border px-2 py-1.5", CARD_TONE)}>
                <div className="flex items-center gap-1.5 mb-1 text-[10px] font-bold uppercase tracking-[0.12em] text-[#d4af37]">
                  <Target className="w-3 h-3" />
                  Earnings · 14d
                </div>
                <ul className="space-y-1">
                  {earningsMerged.map((row) => (
                    <li key={row.date} className="flex items-baseline gap-2 text-[11px]">
                      <span className="font-mono tabular-nums text-sky-300 shrink-0 w-12">
                        {formatMdYy(row.date)}
                      </span>
                      <span className="flex flex-wrap gap-1.5">
                        {row.tickers.map(({ ticker, book }) => (
                          <span
                            key={ticker}
                            title={book ? "book" : "market major"}
                            className={cn(
                              "font-mono font-bold underline underline-offset-2",
                              book
                                ? "text-[#d4af37] decoration-[#d4af37]/35"
                                : "text-violet-300 decoration-violet-400/35",
                            )}
                          >
                            {ticker}
                          </span>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Desk adds + sector | contracts + takeaway */}
            {summary && sections.length > 0 ? (
              <div className="space-y-2">
                {renderSectionCard(sectionByKey.get("adds"), {
                  sourceHint: digSourceTitle(summary.sources ?? []),
                })}
                <div className="grid gap-2 sm:grid-cols-2">
                  {renderSectionCard(sectionByKey.get("sector"), {
                    sourceHint: digSourceTitle(summary.sources ?? []),
                  })}
                  {modelContractsCard}
                </div>
                {renderSectionCard(sectionByKey.get("take"), {
                  span2: true,
                  sourceHint: digSourceTitle(summary.sources ?? []),
                })}
                {[...sectionByKey.entries()]
                  .filter(([k]) => !["adds", "sector", "take"].includes(k))
                  .map(([k, sec]) => (
                    <div key={k}>
                      {renderSectionCard(sec, {
                        span2: true,
                        sourceHint: digSourceTitle(summary.sources ?? []),
                      })}
                    </div>
                  ))}
              </div>
            ) : summary?.content ? (
              <div className="text-[12px] text-amber-50/90 space-y-1">
                {summary.content.split("\n").map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            ) : modelContractsCard ? (
              <div className="grid gap-2 sm:grid-cols-2">{modelContractsCard}</div>
            ) : null}
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
