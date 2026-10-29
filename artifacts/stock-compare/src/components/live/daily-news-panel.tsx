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
import { formatMd, formatMdYy } from "@/lib/format";
import { VERDICT_COLORS, VERDICT_LABELS } from "@/hooks/use-model-list";
import { trustDayPct } from "@/components/live/live-format";
import {
  compressImplicationBullet,
  compressMuseBullet,
  parseSections,
  singleNameLead,
  splitImplicationLead,
  splitMuseSoWhat,
  synthesizeSingleNameSoWhats,
} from "./daily-news-parse";

/** Drop Muse sections/bullets already covered elsewhere on Daily News. */
function dedupeMuseSections(
  sections: Array<{ title: string; bullets: string[] }>,
): Array<{ title: string; bullets: string[] }> {
  const hasMoving = sections.some((s) => /what'?s moving/i.test(s.title));
  return sections
    .filter((s) => {
      // Data = rehash of What's moving (Tue close / overnight / rates)
      if (/^data$/i.test(s.title.trim()) && hasMoving) return false;
      return true;
    })
    .map((s) => {
      if (!/what to watch/i.test(s.title)) return s;
      // Earnings laundry lists → Earnings · 14d strip
      const bullets = s.bullets.filter(
        (b) => !/^Earnings\s+(BMO|AMC)\b/i.test(b) && !/^Earnings\s+\([^)]*reported/i.test(b),
      );
      return { ...s, bullets };
    })
    .filter((s) => s.bullets.length > 0);
}

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

interface MuseBriefSection {
  title: string;
  bullets: string[];
}

interface MuseBrief {
  edition: "am" | "pm";
  file: string;
  title: string;
  banner: string;
  bullets: string[];
  sections?: MuseBriefSection[];
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
  /** AM + PM when both exist for the session */
  museBriefs?: MuseBrief[];
  /** Prior-day brief when today's isn't ready yet (A62) — status line carries the signal */
  museBriefStale?: MuseBrief | null;
  message?: string;
}

interface MarketChip {
  ticker: string;
  price: number | null;
  changePercent: number | null;
}

/** A82 — Kalshi macro + 15m up/down (internal display). */
interface PredMarketsStrip {
  asOf: string;
  fomc: { dateLabel: string; holdPct: number; cutPct: number; hikePct: number; oi: number } | null;
  cpi: { monthLabel: string; medianYoY: number; oi: number } | null;
  btc15m?: { label: string; upPct: number; downPct: number; closesAt: string | null } | null;
  ndq15m?: { label: string; upPct: number; downPct: number; closesAt: string | null } | null;
  intradayNote?: string;
  error?: string;
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
/** Min 2 letters — never paint "T" in Tuesday / "A" in Alphabet. */
const TICKER_RE = /\b([A-Z]{2,5})\b/g;
const TICKER_STOP = new Set([
  "A", "I", "AM", "AN", "AS", "AT", "BE", "BY", "DO", "GO", "IF", "IN", "IS", "IT",
  "ME", "MY", "NO", "OF", "OK", "ON", "OR", "PM", "SO", "TO", "UP", "US", "WE",
  "CEO", "CFO", "CTO", "CPI", "PPI", "GDP", "FED", "FOMC", "PCE", "NFP", "PMI",
  "ISM", "ETF", "IPO", "USD", "JPY", "EUR", "GBP", "OPEC", "NATO", "SEC", "FDA",
  "AI", "TV", "VS", "AND", "THE", "FOR", "BUT", "NOT", "ALL", "ANY",
  "PT", "ET", "EST", "PST", "UTC", "YOY", "QOQ", "MOM", "ATM", "OTM", "ITM",
  "CSP", "CC", "IV", "RV", "DTE", "APR", "YTD", "SK", "ADR", "BMO", "AMC",
]);

type Frag =
  | { kind: "text" | "bold" | "italic" | "ticker" | "num" | "risk" | "opp" | "sector" | "bull" | "bear" | "neut"; text: string };

/** Rewrite ISO YYYY-MM-DD inside free text to m/d/yy; em-dash asides → ·. Keep en-dash ranges (0.1–0.2%). */
function displayDatesInText(text: string): string {
  return text
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) => formatMdYy(`${y}-${m}-${d}`))
    .replace(/\s+—\s+/g, " · ");
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

function pushPlainLean(out: Frag[], text: string) {
  /** Muse path: nums + tickers only — no paint on hold/PM/sector fluff. */
  if (!text) return;
  let last = 0;
  const hits: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(NUM_RE)) {
    if (m.index == null) continue;
    hits.push({ start: m.index, end: m.index + m[0].length });
  }
  hits.sort((a, b) => a.start - b.start);
  const merged: typeof hits = [];
  for (const h of hits) {
    const prev = merged[merged.length - 1];
    if (prev && h.start < prev.end) continue;
    merged.push(h);
  }
  if (merged.length === 0) {
    tickerize(out, text);
    return;
  }
  for (const h of merged) {
    if (h.start > last) tickerize(out, text.slice(last, h.start));
    out.push({ kind: "num", text: text.slice(h.start, h.end) });
    last = h.end;
  }
  if (last < text.length) tickerize(out, text.slice(last));
}

function parseInline(raw: string, opts?: { lean?: boolean }): Frag[] {
  const out: Frag[] = [];
  raw = displayDatesInText(raw);
  const push = opts?.lean ? pushPlainLean : pushPlain;
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;
  let last = 0;
  for (const m of raw.matchAll(re)) {
    if (m.index == null) continue;
    if (m.index > last) push(out, raw.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      const inner = tok.slice(2, -2);
      const nested: Frag[] = [];
      push(nested, inner);
      if (nested.length === 1 && nested[0]!.kind === "text") out.push({ kind: "bold", text: inner });
      else for (const n of nested) out.push(n.kind === "text" ? { kind: "bold", text: n.text } : n);
    } else {
      out.push({ kind: "italic", text: tok.slice(1, -1) });
    }
    last = m.index + tok.length;
  }
  if (last < raw.length) push(out, raw.slice(last));
  return out;
}

function renderFrags(frags: Frag[]): ReactNode[] {
  return frags.map((f, i) => {
    switch (f.kind) {
      case "bold":
        return <strong key={i} className="font-semibold text-white">{f.text}</strong>;
      case "italic":
        return <em key={i} className="italic text-amber-100">{f.text}</em>;
      case "ticker":
        return (
          <span key={i} className="font-mono font-bold text-[#d4af37]">
            {f.text}
          </span>
        );
      case "num":
        return <span key={i} className="font-mono tabular-nums font-semibold text-white">{f.text}</span>;
      case "risk":
        return <span key={i} className="font-semibold text-rose-300">{f.text}</span>;
      case "opp":
        return <span key={i} className="font-semibold text-emerald-300">{f.text}</span>;
      case "sector":
        return <span key={i} className="font-semibold text-white">{f.text}</span>;
      case "bull":
        return <span key={i} className="font-semibold text-emerald-400">{f.text}</span>;
      case "bear":
        return <span key={i} className="font-semibold text-rose-400">{f.text}</span>;
      case "neut":
        return <span key={i} className="font-semibold text-[#d4af37]">{f.text}</span>;
      default:
        return <span key={i}>{f.text}</span>;
    }
  });
}

/** Invisible card chrome — div for structure only, no border waste. */
const CARD_TONE = "border-transparent bg-transparent";
/** Muse / desk section titles — readable gold, not micro-caps. */
const SECTION_HDR =
  "flex items-center gap-2 text-[13px] font-bold uppercase tracking-[0.06em] text-[#d4af37]";
/** Body copy for Muse brief + desk bullets. */
const MUSE_BODY = "text-[13px] text-white leading-relaxed";
const MUSE_DOT = "mt-[7px] w-1.5 h-1.5 rounded-full bg-[#d4af37] shrink-0";
const MUSE_LIST = "grid sm:grid-cols-2 gap-x-6 gap-y-2.5";

function sectionMeta(_title: string) {
  return { tone: CARD_TONE };
}

function fmtTapeLevel(n: number | null, kind: "price" | "yield" | "vix" | "oil" = "price"): string | undefined {
  if (n == null || !Number.isFinite(n)) return undefined;
  if (kind === "yield") return `${n.toFixed(2)}%`;
  if (kind === "vix") return n.toFixed(1);
  if (kind === "oil") return `$${n >= 100 ? n.toFixed(0) : n.toFixed(1)}`;
  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  return n.toFixed(2);
}

function isEmptyDeskFiller(bullets: string[]): boolean {
  if (bullets.length === 0) return true;
  if (bullets.length > 2) return false;
  return bullets.every((b) =>
    /no material|muse covers|muse brief stands|no confirmed rating/i.test(b),
  );
}

function digKindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

function digKindClass(kind: string): string {
  if (kind.includes("upgrade") || kind.includes("price")) {
    return "text-emerald-300 border-transparent bg-transparent";
  }
  if (kind.includes("downgrade")) return "text-rose-300 border-transparent bg-transparent";
  return "text-white border-transparent bg-transparent";
}

const BULL_WORD =
  /\b(upgraded?|upgrade|raised?|overweight|outperform|strong buy|buy|beat|initiates?)\b/gi;
const BEAR_WORD =
  /\b(downgraded?|downgrade|cut|lowered?|underweight|underperform|strong sell|sell|miss(?:ed)?|slashed?)\b/gi;
const NEUT_WORD = /\b(maintain(?:s|ed)?|reiterate[ds]?|hold|neutral|equal[-\s]?weight|market perform)\b/gi;

/** Tape % — Yahoo already sends percent points (0.21 = +0.21%). Never ×100. */
function fmtTapePct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-";
  if (Math.abs(n) < 0.05) return "-";
  if (Math.abs(n) < 1) return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
  const r = Math.round(n);
  return `${r > 0 ? "+" : ""}${r}%`;
}

function roundPctToken(raw: string): string {
  const n = parseFloat(raw.replace(/[\u2212\u2013]/g, "-").replace(/[~%]/g, ""));
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) < 0.05) return "-";
  // Keep one decimal under 10% (futures/oil); whole number for bigger moves
  if (Math.abs(n) < 10) return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
  const r = Math.round(n);
  return `${r > 0 ? "+" : ""}${r}%`;
}

type TapeRow = {
  key: string;
  label: string;
  /** Absolute level when known (price / yield / VIX) */
  level?: string;
  /** DoD % change (or empty when level-only) */
  value: string;
  up: boolean | null;
  title?: string;
};

/** Muse banner → level + % when both present. */
function parseBannerTape(banner: string): TapeRow[] {
  const parts = banner
    .split(/\s*[·|]\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: TapeRow[] = [];
  for (const part of parts) {
    const is10y = /\b10\s*y|\b10yr|\btnx\b/i.test(part);
    const rangePct = part.match(
      /([+\u2212\u2013\-])\s*~?\d+(?:\.\d+)?\s*[\u2013\-]\s*~?(\d+(?:\.\d+)?)\s*%/,
    );
    const parenPct = part.match(/\(([+\u2212\u2013\-]\s*~?\d+(?:\.\d+)?\s*%)\)/);
    const pct = parenPct
      ?? (!rangePct ? part.match(/([+\u2212\u2013\-]\s*~?\d+(?:\.\d+)?\s*%)/) : null);
    const unch = /\(~?unch\)|unchanged/i.test(part);
    let label = part;
    let value = "";
    let level: string | undefined;
    let up: boolean | null = null;
    if (is10y) {
      const lvl = part.match(/(\d+\.\d+)\s*%?/);
      label = "10Y";
      level = lvl ? `${lvl[1]}%` : undefined;
      value = "";
      up = null;
    } else if (rangePct) {
      value = roundPctToken(`${rangePct[1]}${rangePct[2]}%`);
      label = part.slice(0, rangePct.index).trim().replace(/[(\[]\s*$/, "").trim();
      up = value === "-" ? null : value.startsWith("-") ? false : true;
    } else if (pct) {
      value = roundPctToken(pct[1]!);
      // Level before paren %: Brent ~$115 (+~1.5%)
      const before = part.slice(0, pct.index);
      const lvlM = before.match(/~?(\$?[\d,.]+)\s*$/);
      if (lvlM) level = lvlM[1]!.startsWith("$") ? lvlM[1]! : lvlM[1]!;
      label = before.replace(/\s*~?\$?[\d,.]+$/, "").trim().replace(/[(\[]\s*$/, "").trim();
      up = value === "-" ? null : value.startsWith("-") ? false : true;
    } else if (unch) {
      value = "";
      label = part.replace(/\s*\(~?unch\)/i, "").trim();
      up = null;
    } else {
      const lvl = part.match(/^(.+?)\s+~?(\$?[\d,.]+%?)\s*$/);
      if (lvl) {
        label = lvl[1]!.trim();
        level = lvl[2]!.trim();
        value = "";
      } else {
        label = part;
      }
    }
    label = label
      .replace(/^S&P\s*fut(?:ures)?.*$/i, "ES")
      .replace(/^Dow\s*fut(?:ures)?.*$/i, "YM")
      .replace(/^Nasdaq(?:\s*100)?\s*fut(?:ures)?.*$/i, "NQ")
      .replace(/^Brent\b.*/i, "Brent")
      .replace(/^VIX\b.*/i, "VIX");
    if (!label) continue;
    if ((!value || value === "-") && !level) continue;
    if (label === "Brent" && level && !level.startsWith("$")) level = `$${level}`;
    out.push({ key: label.toLowerCase(), label, level, value: value === "-" ? "" : value, up, title: part });
  }
  return out;
}

/** Pull ES/YM/NQ print levels from Muse "near 7,767" prose when banner lacks them. */
function enrichFuturesLevels(rows: TapeRow[], prose: string): TapeRow[] {
  if (!prose) return rows;
  const picks: Array<{ lab: string; re: RegExp }> = [
    { lab: "ES", re: /S&P\s*500\s*futures[^.]{0,100}?near\s+([\d,]+)/i },
    { lab: "YM", re: /Dow\s*futures[^.]{0,80}?near\s+([\d,]+)/i },
    { lab: "NQ", re: /Nasdaq(?:\s*100)?\s*futures[^.]{0,100}?near\s+([\d,]+)/i },
  ];
  return rows.map((r) => {
    if (r.level || !["ES", "YM", "NQ"].includes(r.label)) return r;
    const hit = picks.find((p) => p.lab === r.label);
    if (!hit) return r;
    const m = prose.match(hit.re);
    if (!m) return r;
    return { ...r, level: m[1]!.replace(/,/g, "") };
  });
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
  /** Muse AM vs prior/same-day EOD commentary */
  const [museTab, setMuseTab] = useState<"am" | "pm">("am");

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

  const { data: predMarkets } = useQuery({
    queryKey: ["live-pred-markets"],
    queryFn: async (): Promise<PredMarketsStrip> => {
      const r = await fetch("/api/live/pred-markets", { credentials: "include" });
      if (!r.ok) throw new Error("pred-markets failed");
      return r.json();
    },
    // 15m markets need fresher polls; FOMC/CPI still hourly-cached server-side.
    staleTime: 45_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  /** A143 — OpenJev overnight labels (display only). */
  const { data: ojLabels } = useQuery({
    queryKey: ["desk-oj-labels"],
    queryFn: async (): Promise<{ note: string; items: Array<{ ticker: string; headline: string; url: string | null; dir: number; cat: string }> }> => {
      const r = await fetch("/api/desk-commentaries/daily-news/oj-labels", { credentials: "include" });
      if (!r.ok) throw new Error("oj-labels failed");
      return r.json();
    },
    staleTime: 15 * 60_000,
    refetchOnWindowFocus: false,
    enabled: !!isAdmin,
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
  const museBriefs = useMemo(() => {
    const list = data?.museBriefs?.length ? data.museBriefs : (museBrief ? [museBrief] : []);
    return list.filter((b) => (b.sections?.length ?? 0) > 0 || b.bullets.length > 0);
  }, [data?.museBriefs, museBrief]);
  const museAm = useMemo(() => museBriefs.find((b) => b.edition === "am") ?? null, [museBriefs]);
  const musePm = useMemo(() => museBriefs.find((b) => b.edition === "pm") ?? null, [museBriefs]);
  const activeMuse = museTab === "pm" ? (musePm ?? museAm) : (museAm ?? musePm);

  const yahooTape: TapeRow[] = useMemo(() => {
    const by = new Map((tape?.marketContext ?? []).map((c) => [c.ticker, c]));
    return YAHOO_TAPE_ORDER.flatMap((t): TapeRow[] => {
      const c = by.get(t);
      if (!c) return [];
      if (t === "^TNX") {
        const level = fmtTapeLevel(c.price, "yield");
        return [{
          key: t,
          label: "10Y",
          level,
          value: "",
          up: null,
          title: "10Y treasury yield",
        }];
      }
      if (t === "^VIX") {
        const tr = trustDayPct(c.changePercent);
        const pct = tr.flagged || tr.text === "—" ? "" : tr.text;
        return [{
          key: t,
          label: "VIX",
          level: fmtTapeLevel(c.price, "vix"),
          value: pct,
          up: pct ? (c.changePercent ?? 0) >= 0 : null,
          title: tr.title ?? "VIX level + session 1d %",
        }];
      }
      const up = c.changePercent == null ? null : c.changePercent >= 0;
      const value = fmtTapePct(c.changePercent);
      return [{
        key: t,
        label: t.replace("^", ""),
        level: fmtTapeLevel(c.price, "price"),
        value: value === "-" ? "" : value,
        up: value === "-" || !value ? null : up,
        title: `${t.replace("^", "")} last + session 1d %`,
      }];
    });
  }, [tape?.marketContext]);

  const bannerTape: TapeRow[] = useMemo(() => {
    const banner = activeMuse?.banner ?? museAm?.banner ?? museBrief?.banner;
    if (!banner) return [];
    const prose = (activeMuse?.bullets ?? museBriefs.flatMap((b) => b.bullets)).join(" ");
    return enrichFuturesLevels(parseBannerTape(banner), prose);
  }, [activeMuse, museAm, museBriefs, museBrief?.banner]);

  /** Muse banner wins futures/Brent/VIX/10Y; Yahoo fills SPY/QQQ (+ prices). */
  const liveTape = useMemo(() => {
    const order = ["SPY", "QQQ", "VIX", "10Y", "ES", "YM", "NQ", "Brent"] as const;
    const by = new Map<string, TapeRow>();
    const put = (r: TapeRow, prefer = false) => {
      if (r.value === "stale") return;
      if (!r.level && !r.value) return;
      const lab = r.label === "10Y" ? "10Y"
        : r.label === "VIX" || r.key === "^VIX" || r.key === "vix" ? "VIX"
          : r.label;
      const prev = by.get(lab);
      if (!prev || prefer) {
        by.set(lab, {
          ...r,
          label: lab,
          key: lab.toLowerCase(),
          level: r.level ?? prev?.level,
          value: r.value || prev?.value || "",
        });
      } else {
        by.set(lab, {
          ...prev,
          level: prev.level ?? r.level,
          value: prev.value || r.value,
          up: prev.up ?? r.up,
        });
      }
    };
    for (const r of yahooTape) put(r, false);
    for (const r of bannerTape) put(r, true);
    return order.flatMap((lab) => {
      const r = by.get(lab);
      return r ? [r] : [];
    });
  }, [yahooTape, bannerTape]);

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
    opts?: { className?: string; span2?: boolean; sourceHint?: string; hideFiller?: boolean },
  ) => {
    if (!sec) return null;
    if (opts?.hideFiller && isEmptyDeskFiller(sec.bullets)) return null;
    const meta = sectionMeta(sec.title);
    return (
      <div
        className={cn(
          "rounded-md border px-0 py-1",
          meta.tone,
          opts?.span2 && "sm:col-span-2",
          opts?.className,
        )}
      >
        <div className={cn(SECTION_HDR, "mb-2")}>
          <TrendingUp className="w-3.5 h-3.5 shrink-0" />
          <h3>{sec.title}</h3>
        </div>
        <ul className="space-y-2">
          {sec.bullets.map((b, i) => (
            <li key={i} className="group flex items-start gap-2" title={opts?.sourceHint ?? digSourceTitle(summary?.sources ?? [])}>
              <span className={MUSE_DOT} />
              <p className={cn("flex-1", MUSE_BODY)}>
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
                  className="opacity-0 group-hover:opacity-100 p-0.5 text-white hover:text-red-400"
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
    <div className={cn("rounded-md border px-0 py-1 h-full min-h-0 flex flex-col", CARD_TONE)}>
      <div className={cn(SECTION_HDR, "mb-2 shrink-0")}>
        <TrendingUp className="w-3.5 h-3.5 shrink-0" />
        <h3>Model contracts</h3>
      </div>
      <ul className="space-y-2 overflow-y-auto min-h-0 flex-1">
        {modelContracts.map((c) => {
          const tip = [c.folder, c.verdict ? (VERDICT_LABELS[c.verdict] ?? c.verdict) : "", c.status]
            .filter(Boolean)
            .join(" · ");
          const color = VERDICT_COLORS[c.verdict] ?? "#d4af37";
          return (
            <li key={`${c.ticker}-${c.folder}`} className={MUSE_BODY}>
              <span
                className="font-mono font-bold"
                style={{ color }}
                title={tip}
              >
                {c.ticker}
              </span>
              {": sell "}
              <span className={c.side === "put" ? "text-emerald-400" : "text-white"}>{c.side}</span>
              {" "}
              <span className="font-mono tabular-nums font-semibold text-white">
                {c.strike != null ? `$${c.strike}` : "?"}
              </span>
              {" exp "}
              <span className="font-mono tabular-nums">{formatMd(c.expiry)}</span>
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
  const asOfStamp = [headerDate, genTime].filter(Boolean).join(" · ");
  const tabCls = (on: boolean) =>
    cn(
      "px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide border",
      on
        ? "border-[#d4af37]/50 bg-[#d4af37]/15 text-[#d4af37]"
        : "border-transparent text-white hover:text-[#d4af37]",
    );

  const overnightBlock = !!ojLabels?.items?.length ? (
    <div
      className="space-y-0.5 min-h-0 flex-1 flex flex-col"
      title={ojLabels.note || "OpenJev overnight headlines (rel>0.5) — display only, not a forecast"}
    >
      <div className={cn(SECTION_HDR, "shrink-0")} title="Local OpenJev labels on overnight headlines (A143). Not desk synthesis.">
        Overnight · OpenJev
      </div>
      <ul className="space-y-0.5 overflow-y-auto min-h-0 flex-1">
        {ojLabels.items.slice(0, 12).map((it, i) => {
          const tone = it.dir > 0.15 ? "text-emerald-300" : it.dir < -0.15 ? "text-rose-300" : "text-white";
          return (
            <li key={`${it.ticker}-${i}`} className="text-[10px] flex gap-1.5 min-w-0">
              <span className="font-semibold text-white shrink-0 w-10">{it.ticker}</span>
              <span className={cn("shrink-0 rounded-full px-1.5 border border-white/20", tone)}>{it.cat}</span>
              {it.url ? (
                <a href={it.url} target="_blank" rel="noreferrer" className={cn("truncate hover:underline", tone)}>{it.headline}</a>
              ) : (
                <span className={cn("truncate", tone)}>{it.headline}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  ) : null;

  return (
    <div className={cn(
      "rounded-md border border-transparent bg-zinc-950 overflow-hidden",
      !compact && "shadow-none",
    )}>
      <div className="px-1 py-1 flex items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#d4af37]">
          <Sparkles className="w-3 h-3 shrink-0" />
          Daily News
          {(museAm || musePm) && (
            <span className="inline-flex items-center gap-0.5 normal-case tracking-normal ml-0.5">
              <button type="button" className={tabCls(museTab === "am")} onClick={() => setMuseTab("am")} disabled={!museAm}>
                AM
              </button>
              <button
                type="button"
                className={tabCls(museTab === "pm")}
                onClick={() => setMuseTab("pm")}
                disabled={!musePm}
                title={musePm?.stale ? `Prior EOD · ${musePm.asOfYmd ?? ""}` : "End of day"}
              >
                EOD{musePm?.stale ? "*" : ""}
              </button>
            </span>
          )}
          {newCount > 0 && (
            <span className="text-[10px] font-bold text-red-400 normal-case tracking-normal">
              · {newCount} new
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {asOfStamp && (
            <span className="text-[10px] text-white flex items-center gap-1 font-mono" title="Session date · last Desk adds">
              <Clock className="w-3 h-3" />
              {asOfStamp}
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

      <div className="px-1 py-1 space-y-2">
        {/* Oval tape: LABEL level pct */}
        {liveTape.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {liveTape.map((row, i) => (
              <span
                key={`${row.key}-${i}`}
                className="inline-flex items-baseline gap-1 shrink-0 rounded-full border border-[#d4af37]/35 bg-zinc-950 px-2 py-0.5 text-[10px] font-mono tabular-nums"
                title={row.title ?? row.label}
              >
                <span className="text-white">{row.label}</span>
                {row.level && <span className="text-white">{row.level}</span>}
                {row.value && (
                  <span
                    className={cn(
                      row.up === true && "text-emerald-400",
                      row.up === false && "text-rose-400",
                      row.up == null && "text-white",
                    )}
                  >
                    {row.value}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}

        {/* A82 — one Kalshi tag wrapping FOMC + CPI + 15m */}
        {(predMarkets?.fomc || predMarkets?.cpi || predMarkets?.btc15m || predMarkets?.ndq15m) && (
          <div
            className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5 max-w-full rounded-full border border-cyan-400/40 bg-zinc-950 px-2.5 py-0.5 text-[10px] font-mono tabular-nums text-white"
            title={predMarkets.intradayNote || "Kalshi market odds · internal use only · not advice"}
          >
            <span className="text-cyan-300 shrink-0 font-semibold">Kalshi</span>
            {predMarkets.btc15m && (
              <span
                className={cn(
                  "shrink-0",
                  predMarkets.btc15m.upPct >= 55 ? "text-emerald-400"
                    : predMarkets.btc15m.upPct <= 45 ? "text-red-400" : undefined,
                )}
                title="BTC next-15m up probability (crowd)"
              >
                BTC 15m ↑{predMarkets.btc15m.upPct}%
              </span>
            )}
            {predMarkets.ndq15m && (
              <span
                className={cn(
                  "shrink-0",
                  predMarkets.ndq15m.upPct >= 55 ? "text-emerald-400"
                    : predMarkets.ndq15m.upPct <= 45 ? "text-red-400" : undefined,
                )}
                title="NDX next-15m up probability when listed"
              >
                NDQ 15m ↑{predMarkets.ndq15m.upPct}%
              </span>
            )}
            {predMarkets.fomc && (
              <span className="shrink-0" title={`OI ${predMarkets.fomc.oi.toLocaleString()}`}>
                FOMC {predMarkets.fomc.dateLabel}: hold {predMarkets.fomc.holdPct}%
                {predMarkets.fomc.cutPct > 0 ? ` · cut ${predMarkets.fomc.cutPct}%` : ""}
                {predMarkets.fomc.hikePct > 0 ? ` · hike ${predMarkets.fomc.hikePct}%` : ""}
              </span>
            )}
            {predMarkets.cpi && (
              <span className="shrink-0" title={`OI ${predMarkets.cpi.oi.toLocaleString()}`}>
                CPI {predMarkets.cpi.monthLabel}: ~{predMarkets.cpi.medianYoY}% YoY
              </span>
            )}
          </div>
        )}

        {/* Active Muse tab (AM | EOD) — sections only; title lives in header tabs */}
        {activeMuse && (
          <div className="space-y-5">
            {activeMuse.stale && (
              <p className="text-[12px] text-amber-200 font-mono">
                Prior session · {activeMuse.asOfYmd ? formatMdYy(activeMuse.asOfYmd) : activeMuse.file}
              </p>
            )}
            {dedupeMuseSections(
              activeMuse.sections?.length
                ? activeMuse.sections
                : [{ title: activeMuse.edition === "am" ? "What's moving" : "Recap", bullets: activeMuse.bullets }],
            ).map((sec) => {
              const isSingles = /single names/i.test(sec.title);
              const isImpl = /implications/i.test(sec.title);
              const split =
                (/what'?s moving|why it matters|what to watch|single names|implications/i.test(sec.title)
                  && sec.bullets.length >= 2);

              if (isSingles) {
                const splitRows = sec.bullets.map((b) => {
                  const { fact, soWhat } = splitMuseSoWhat(b);
                  const factC = compressMuseBullet(fact);
                  return {
                    fact: factC,
                    lead: singleNameLead(factC) || singleNameLead(fact),
                    soWhat,
                    raw: b,
                  };
                });
                const soWhatSyn = synthesizeSingleNameSoWhats(
                  splitRows
                    .filter((r): r is typeof r & { soWhat: string } => !!r.soWhat)
                    .map((r) => ({ lead: r.lead, soWhat: r.soWhat })),
                );
                return (
                  <section key={sec.title} className="space-y-3 border-t border-[#d4af37]/15 pt-4 first:border-t-0 first:pt-0">
                    <div className="space-y-2">
                      <div className={SECTION_HDR}>{sec.title}</div>
                      <ul className={cn(split ? MUSE_LIST : "space-y-2")}>
                        {splitRows.map((r, i) => (
                          <li
                            key={i}
                            className={cn("flex items-start gap-2", MUSE_BODY)}
                            title={r.raw}
                          >
                            <span className={MUSE_DOT} />
                            <span className="min-w-0 flex-1">
                              {renderFrags(parseInline(r.fact, { lean: true }))}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                    {soWhatSyn.length > 0 && (
                      <div className="space-y-2 pl-0 sm:pl-0">
                        <div className={SECTION_HDR}>So what?</div>
                        <ul className={MUSE_LIST}>
                          {soWhatSyn.map((line, i) => (
                            <li key={i} className={cn("flex items-start gap-2", MUSE_BODY)}>
                              <span className={MUSE_DOT} />
                              <span className="min-w-0 flex-1">
                                {renderFrags(parseInline(line, { lean: true }))}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </section>
                );
              }

              return (
                <section key={sec.title} className="space-y-2 border-t border-[#d4af37]/15 pt-4 first:border-t-0 first:pt-0">
                  <div className={SECTION_HDR}>{sec.title}</div>
                  <ul className={cn(split ? MUSE_LIST : "space-y-2")}>
                    {sec.bullets.map((b, i) => {
                      const text = isImpl ? compressImplicationBullet(b) : compressMuseBullet(b);
                      const lead = isImpl ? splitImplicationLead(text) : null;
                      return (
                        <li
                          key={i}
                          className={cn("flex items-start gap-2", MUSE_BODY)}
                          title={b}
                        >
                          <span className={MUSE_DOT} />
                          <span className="min-w-0 flex-1">
                            {lead ? (
                              <>
                                <span className="font-semibold text-[#d4af37]">{lead.lead}</span>
                                <span className="text-amber-100"> — </span>
                                {renderFrags(parseInline(lead.body, { lean: true }))}
                              </>
                            ) : (
                              renderFrags(parseInline(text, { lean: true }))
                            )}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
        {!activeMuse && data?.museBriefStale && (
          <div className="py-1">
            <div className={cn(SECTION_HDR, "text-amber-300")}>
              <Sparkles className="w-3 h-3" />
              No brief yet today
            </div>
            <p className="mt-1 text-[11px] text-white">
              Last Muse {data.museBriefStale.edition.toUpperCase()}
              {data.museBriefStale.asOfYmd ? ` · ${formatMdYy(data.museBriefStale.asOfYmd)}` : ""}{" "}
              is from a prior session — waiting for today’s brief.
            </p>
          </div>
        )}

        {isLoading && !data && (
          <p className="text-[11px] text-white">Loading…</p>
        )}
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {feedbackMsg && <p className="text-[10px] text-emerald-400">{feedbackMsg}</p>}
        {generating && !summary && (
          <p className="text-[11px] text-white">Digging links + summarizing session…</p>
        )}
        {!generating && !summary && (data?.todayCount ?? 0) === 0 && (
          <p className="text-[11px] text-white">
            No emails in {data?.sessionLabel ?? "this session"} yet. Label with{" "}
            <code className="text-[#d4af37]">tradedash-brief</code>.
          </p>
        )}
        {!generating && !summary && (data?.todayCount ?? 0) > 0 && (
          <p className="text-[11px] text-white">
            {data!.includedCount ?? data!.todayCount} emails ready
            {(data!.excludedCount ?? 0) > 0 ? ` (${data!.excludedCount} noise)` : ""}.
          </p>
        )}

        {(summary || earningsRows.length > 0 || marketEarningsRows.length > 0 || modelContracts.length > 0) && (
          <div className="min-h-[240px] max-h-[min(72vh,780px)] overflow-y-auto pr-1 space-y-3">
            {summary && data?.materialSuggested && newCount > 0 && (
              <p className="text-[11px] font-semibold text-red-400">
                Updates ready ({newCount} new)
              </p>
            )}

            {/* Dig — source on hover (title), not a grey column */}
            {digFacts.length > 0 && (
              <div className={cn("rounded-md border px-0 py-1", CARD_TONE)}>
                <div className={cn(SECTION_HDR, "mb-1")}>
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
                        <span className="text-[9px] uppercase text-white shrink-0 pt-0.5">{digKindLabel(f.kind)}</span>
                        <span className="text-white min-w-0 flex-1 break-words">
                          {renderFrags(parseInline(f.detail))}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Left: Earnings + Overnight (stacked, shared height) | Right: Model contracts */}
            {(earningsMerged.length > 0 || modelContractsCard || overnightBlock) && (
              <div className="grid gap-3 sm:grid-cols-2 items-stretch min-h-[280px]">
                <div className="flex flex-col gap-2 min-h-0 h-full">
                  {earningsMerged.length > 0 && (
                    <div className={cn("rounded-md border px-0 py-1 shrink-0", CARD_TONE)}>
                      <div className={cn(SECTION_HDR, "mb-1")}>
                        <Target className="w-3 h-3" />
                        Earnings · 14d
                      </div>
                      <ul className="space-y-1 max-h-40 overflow-y-auto">
                        {earningsMerged.map((row) => (
                          <li key={row.date} className="flex items-baseline gap-2 text-[11px]">
                            <span className="font-mono tabular-nums text-sky-300 shrink-0 w-8">
                              {formatMd(row.date)}
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
                  {overnightBlock}
                </div>
                {modelContractsCard}
              </div>
            )}

            {/* Desk adds + sector + takeaway (hide empty Sector filler) */}
            {summary && sections.length > 0 ? (
              <div className="space-y-2">
                {renderSectionCard(sectionByKey.get("adds"), {
                  sourceHint: digSourceTitle(summary.sources ?? []),
                })}
                {renderSectionCard(sectionByKey.get("sector"), {
                  sourceHint: digSourceTitle(summary.sources ?? []),
                  hideFiller: true,
                })}
                {renderSectionCard(sectionByKey.get("take"), {
                  sourceHint: digSourceTitle(summary.sources ?? []),
                })}
                {[...sectionByKey.entries()]
                  .filter(([k]) => !["adds", "sector", "take"].includes(k))
                  .map(([k, sec]) => (
                    <div key={k}>
                      {renderSectionCard(sec, {
                        hideFiller: true,
                        sourceHint: digSourceTitle(summary.sources ?? []),
                      })}
                    </div>
                  ))}
              </div>
            ) : summary?.content ? (
              <div className="text-[12px] text-white space-y-1">
                {summary.content.split("\n").map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
              </div>
            ) : null}
          </div>
        )}

        {isAdmin && (
          <div className="flex items-center gap-1 border-t border-zinc-800 pt-2">
            <MessageCircleQuestion className="w-3 h-3 text-amber-100/80 shrink-0" />
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
              className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-700 text-amber-100 hover:text-[#d4af37] disabled:opacity-40"
            >
              Ask
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
