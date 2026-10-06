import { useState, useRef, useCallback, useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Loader2, Search, AlertCircle, BarChart2, TrendingUp, TrendingDown, LineChart,
} from "lucide-react";
import { PriceChart, Period } from "./price-chart";
import { TradingViewTechnicalWidget } from "./tradingview-technical-widget";
import { CompetitorsSection } from "./competitors-section";
import { AnalystRatingsSection, type Recommendations, type AnalystAction, type AnalystPriceTarget, type PriceTargetRange } from "./analyst-ratings-section";
import { EarningsHistorySection, type EarningsQuarter } from "./earnings-history-section";
import { MarketSentimentSection, BullBearCases } from "./market-sentiment-section";
import { AccountingStatementsSection } from "./accounting-statements-section";
import { NewsCard, type NewsItem } from "./news-card";
import { BreakdownMetricsTable, ScoreBadge } from "./breakdown-metrics-table";
import { PegGrowthDistChart } from "./peg-growth-dist-chart";
import { PeerGroupEditor } from "./settings/PeerGroupEditor";
import { FundScoreHistoryChart, type ScoreHistoryPoint } from "./fund-score-history-chart";
import { StreetSynthesisCard, type StreetSynthesisData } from "./street-synthesis-card";
import { ScoreNoteForm } from "./score-note-form";
import { useAuth } from "@/context/AuthContext";
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import { formatCurrency, formatLargeNumber, formatNumber, formatPercent } from "@/lib/format";
import { addToScannerShelf } from "@/lib/ticker-shelf-storage";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ModelThesisReport, type ModelThesis } from "@/components/model-thesis-report";
import { FairValueBadge } from "@/components/fair-value-badge";

function scoreTone(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return "border-white/40 text-white/70 bg-zinc-800";
  if (score >= 70) return "border-green-400 text-white bg-green-600/40";
  if (score >= 50) return "border-yellow-400 text-white bg-yellow-600/35";
  if (score >= 35) return "border-orange-400 text-white bg-orange-600/35";
  return "border-red-400 text-white bg-red-600/40";
}

function PillarChip({ label, score, title }: { label: string; score: number | null | undefined; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded border text-[11px] font-mono tabular-nums",
        scoreTone(score),
      )}
    >
      <span className="text-[9px] font-bold uppercase tracking-wide font-sans">{label}</span>
      <span className="font-bold">{score != null && Number.isFinite(score) ? score.toFixed(0) : "—"}</span>
    </span>
  );
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface ScoreEvidence {
  total: number | null;
  value: number | null;
  growth: number | null;
  quality: number | null;
  safety: number | null;
  style: string | null;
  confidence: string | null;
  coverage: number | null;
  scoredAt: string | null;
  topMetrics: Array<{ key: string; family: string; raw: number | null; peerPct: number | null; contrib: number }>;
  modelScore: number | null;
  deskScore: number | null;
  activeAdjPoints: number;
}

interface TradeOverlay {
  techScore: number | null;
  atmPutIv: number | null;
  realizedVol20d: number | null;
  ivVsRealized: number | null;
  earningsDaysOut: number | null;
  streetEventRisk: boolean;
  regime: string | null;
}

interface BreakdownData {
  metrics: any;
  scoreEvidence?: ScoreEvidence | null;
  scoreHistory?: ScoreHistoryPoint[];
  street?: StreetSynthesisData | null;
  tradeOverlay?: TradeOverlay | null;
  recommendations: Recommendations | null;
  analystActions: AnalystAction[];
  analystPriceTargets: AnalystPriceTarget[];
  priceTargetRange: PriceTargetRange | null;
  bullBullets: string[];
  bearBullets: string[];
  news: NewsItem[];
  earningsDate?: string | null;
  earningsHistory?: EarningsQuarter[];
  catalysts?: string[];
  peers?: string[];
  peerIndustry?: string | null;
  peerSector?: string | null;
}

// ── Data fetching ──────────────────────────────────────────────────────────────

function useBreakdown(ticker: string | null) {
  return useQuery<BreakdownData, Error>({
    queryKey: ["breakdown", ticker],
    queryFn: async () => {
      const res = await fetch(`/api/stocks/breakdown?ticker=${encodeURIComponent(ticker!)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    enabled: !!ticker,
    staleTime: 10 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    retry: 1,
  });
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function overviewBullets(description: string, companyName: string | null | undefined): string[] {
  const sentences = description.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter((s, i) => {
    if (i !== 0) return true;
    if (!companyName?.trim()) return true;
    const trimmed = s.trim();
    const name = companyName.trim();
    if (trimmed.toLowerCase().startsWith(name.toLowerCase())) return false;
    if (trimmed.replace(/[.!?]+$/, "").toLowerCase() === name.toLowerCase()) return false;
    return true;
  });
  return filtered.slice(0, 3);
}

// ── Classification tags (exchange/sector/industry/stockType) ───────────────────
// Each tag type gets its own color so the row reads as distinct categories rather
// than a wall of grey text. Clicking a tag opens a popup listing other watchlist
// tickers sharing that same value.

type ClassificationTagType = "exchange" | "sector" | "industry" | "stockType";
type TagType = ClassificationTagType | "beta" | "marketCap";

interface WatchlistTagEntry {
  companyName?: string | null;
  exchange?: string | null;
  sector?: string | null;
  industry?: string | null;
  stockType?: string | null;
}

const TAG_STYLES: Record<TagType, string> = {
  exchange:  "border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20",
  sector:    "border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20",
  industry:  "border-teal-500/30 bg-teal-500/10 text-teal-300 hover:bg-teal-500/20",
  stockType: "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20",
  beta:      "border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
  marketCap: "border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20",
};

function TagBadge({
  type, value, matches, onSelectTicker,
}: {
  type: TagType; value: string;
  matches?: { ticker: string; companyName: string | null }[];
  onSelectTicker?: (t: string) => void;
}) {
  const badgeClass = cn(
    "text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border transition-colors",
    matches ? "cursor-pointer" : "cursor-default",
    TAG_STYLES[type],
  );

  if (!matches) {
    return <button type="button" disabled className={badgeClass}>{value}</button>;
  }

  // Styled to match the Live Monitor intraday regime checkpoint popover (live.tsx).
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(badgeClass, "hover:brightness-125")}>{value}</button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0 text-xs bg-zinc-900 border-zinc-600/40" align="start">
        <div className="px-3 py-2 border-b border-amber-500/20 bg-zinc-800/90 flex items-center gap-2">
          <span className={cn("text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border shrink-0", TAG_STYLES[type])}>
            {value}
          </span>
          <span className="text-zinc-400 text-[11px]">
            {matches.length} ticker{matches.length !== 1 ? "s" : ""} in your watchlist
          </span>
        </div>
        <div className="p-2 flex flex-col gap-0.5 max-h-72 overflow-y-auto">
          {matches.length === 0 ? (
            <span className="text-zinc-500 italic px-1.5 py-1">No other watchlist tickers share this tag.</span>
          ) : (
            matches.map(({ ticker: t, companyName }) => (
              <button
                key={t}
                onClick={() => onSelectTicker?.(t)}
                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="font-mono font-bold text-xs text-white">{t}</span>
                {companyName && <span className="text-[11px] text-zinc-400 truncate">{companyName}</span>}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

type BreakdownPanelProps = {
  title: string;
  children?: ReactNode;
  empty?: string;
  /** Span both columns in the 2-col grid. */
  fullWidth?: boolean;
  /** Optional right-side action (e.g. Open dig). */
  action?: ReactNode;
  /** Cap height + scroll only when content is long (charts). */
  scrollMax?: string;
};

function BreakdownPanel({ title, children, empty, fullWidth, action, scrollMax }: BreakdownPanelProps) {
  return (
    <div
      className={cn(
        "bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-2.5 flex flex-col min-h-0 h-full",
        fullWidth && "col-span-2",
      )}
    >
      <div className="flex items-center justify-between mb-1.5 gap-2 shrink-0">
        <span className="text-[11px] font-bold tracking-tight text-[#d4af37] truncate">{title}</span>
        {action}
      </div>
      <div
        className={cn(
          "min-h-0",
          scrollMax ?? "flex-1 overflow-y-auto",
          scrollMax && !/overflow-/.test(scrollMax) && "overflow-y-auto",
        )}
      >
        {children ?? (
          <p className="text-[10px] text-amber-200/40 italic">{empty ?? "No data available."}</p>
        )}
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export function StockBreakdown({
  ticker: propTicker,
  watchlistMetrics,
  modelThesis,
}: {
  ticker?: string;
  watchlistMetrics?: Record<string, WatchlistTagEntry | undefined>;
  /** When opened from Model List — conviction report pinned above the breakdown. */
  modelThesis?: ModelThesis | null;
} = {}) {
  const [, navigate] = useLocation();
  const { isAdmin } = useAuth();
  const [inputText, setInputText] = useState(propTicker ?? "");
  const [activeTicker, setActiveTicker] = useState<string | null>(propTicker ?? null);
  const [chartPeriod, setChartPeriod] = useState<Period>("1W");
  const [tvOpen, setTvOpen] = useState(false);
  const [peerEditOpen, setPeerEditOpen] = useState(false);
  const [digTab, setDigTab] = useState<"news" | "history" | "accounting">("news");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // When driven by watchlist click, sync ticker from prop
  useEffect(() => {
    if (propTicker) {
      setActiveTicker(propTicker);
      setInputText(propTicker);
      setChartPeriod("1W");
    }
  }, [propTicker]);

  const debouncedQuery = useDebounce(inputText, 180);

  const { data: searchResults, isFetching: isSearching } = useSearchStocks(
    { q: debouncedQuery },
    {
      query: {
        enabled: debouncedQuery.length >= 1,
        queryKey: getSearchStocksQueryKey({ q: debouncedQuery }),
        staleTime: 5 * 60 * 1000,
      },
    },
  );

  const suggestions =
    dropdownOpen && (searchResults?.length ?? 0) > 0 ? searchResults! : [];

  const { data, isLoading, error } = useBreakdown(activeTicker);

  const tagMatchesFor = useCallback((type: ClassificationTagType, value: string) => {
    if (!watchlistMetrics) return undefined;
    return Object.entries(watchlistMetrics)
      .filter(([, m]) => m?.[type] === value)
      .map(([t, m]) => ({ ticker: t, companyName: m?.companyName ?? null }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [watchlistMetrics]);

  const commitTicker = useCallback((t: string) => {
    const upper = t.trim().toUpperCase();
    if (!upper) return;
    setActiveTicker(upper);
    setInputText(upper);
    setDropdownOpen(false);
    setFocusedIdx(-1);
    setChartPeriod("1W");
    setDigTab("news");
    setPeerEditOpen(false);
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputText(e.target.value.toUpperCase());
    setDropdownOpen(true);
    setFocusedIdx(-1);
  };

  const handleFocus = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    if (inputText.length >= 1) setDropdownOpen(true);
  };

  const handleBlur = () => {
    closeTimer.current = setTimeout(() => setDropdownOpen(false), 150);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (focusedIdx >= 0 && suggestions[focusedIdx]) {
        commitTicker(suggestions[focusedIdx].ticker);
      } else {
        commitTicker(inputText);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocusedIdx((i) => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocusedIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Escape") {
      setDropdownOpen(false);
    }
  };

  const m = data?.metrics;
  const dayUp = (m?.dayChange ?? 0) >= 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Search header — hidden when ticker is driven by parent (e.g. watchlist) */}
      {!propTicker && <div className="shrink-0 border-b border-[#d4af37]/20 bg-zinc-900/95 backdrop-blur px-6 py-3 z-10">
        <div className="max-w-5xl mx-auto flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none z-10" />
            {isSearching && debouncedQuery.length >= 1 && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 animate-spin z-10" />
            )}
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={inputText}
              onChange={handleChange}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              placeholder="Enter ticker (e.g. AAPL, TSLA, MSFT)…"
              className="w-full h-10 pl-9 pr-9 text-sm font-mono bg-white border border-white/20 text-black placeholder:text-gray-500 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
            />
            {dropdownOpen && suggestions.length > 0 && (
              <ul className="absolute top-full left-0 right-0 mt-1 z-50 bg-card border border-border rounded-lg shadow-xl overflow-hidden max-h-52 overflow-y-auto">
                {suggestions.map((r, i) => (
                  <li
                    key={r.ticker}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      commitTicker(r.ticker);
                    }}
                    className={cn(
                      "px-3 py-2 text-sm cursor-pointer flex items-center justify-between hover:bg-primary/10",
                      i === focusedIdx && "bg-primary/10",
                    )}
                  >
                    <span className="font-mono font-bold">{r.ticker}</span>
                    <span className="text-muted-foreground text-xs truncate ml-2 max-w-[180px]">
                      {r.name}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <button
            onClick={() => commitTicker(inputText)}
            className="px-5 h-10 bg-primary text-primary-foreground text-sm font-semibold rounded-lg hover:bg-primary/90 transition-colors shrink-0"
          >
            Analyze
          </button>
        </div>
      </div>}

      {/* Content area */}
      <div className="flex-1 overflow-y-auto">
        {/* Empty state */}
        {!activeTicker && (
          <div className="h-full flex flex-col items-center justify-center text-center text-muted-foreground/60 gap-4 py-20">
            <div className="w-16 h-16 rounded-2xl bg-secondary/50 flex items-center justify-center border border-dashed border-border">
              <BarChart2 className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-medium">Enter a ticker to get the full breakdown</p>
              <p className="text-xs mt-1 text-muted-foreground/40">
                Valuation · Growth · Health · Analyst Ratings · News
              </p>
            </div>
          </div>
        )}

        {/* Model List thesis — top of the report, even while quotes load */}
        {modelThesis && activeTicker && modelThesis.item.ticker === activeTicker && (
          <div className="max-w-5xl mx-auto px-5 pt-4 pb-0">
            <ModelThesisReport thesis={modelThesis} />
          </div>
        )}

        {/* Loading */}
        {activeTicker && isLoading && (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3 text-muted-foreground">
              <Loader2 className="w-8 h-8 animate-spin" />
              <span className="text-sm">Loading {activeTicker}…</span>
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="max-w-5xl mx-auto px-6 pt-8">
            <div className="flex items-start gap-3 bg-red-500/10 border border-red-500/20 text-red-400 rounded-xl p-4">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span className="text-sm">{error.message}</span>
            </div>
          </div>
        )}

        {/* Main content */}
        {m && !isLoading && (
          <div className="max-w-5xl mx-auto px-5 py-4 space-y-3 pb-8">
            {/* ── Header ── */}
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        className="text-2xl font-bold font-mono tracking-tight shrink-0 cursor-pointer decoration-dotted underline-offset-4 hover:underline text-left"
                        title="Company overview"
                      >
                        {m.ticker}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent
                      side="bottom"
                      align="start"
                      className="max-w-sm w-[min(24rem,calc(100vw-2rem))] bg-card text-foreground border border-border p-3 z-[80]"
                    >
                      <span className="text-xs font-bold tracking-tight text-foreground block mb-1.5">Company Overview</span>
                      {m.description ? (
                        <ul className="space-y-1.5">
                          {overviewBullets(m.description, m.companyName).map((s: string, i: number) => (
                            <li key={i} className="flex gap-1.5 text-xs text-foreground leading-snug">
                              <span className="shrink-0 text-foreground mt-0.5">•</span>
                              {s}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="text-xs text-muted-foreground">No description available.</p>
                      )}
                    </PopoverContent>
                  </Popover>
                  <span className="text-base text-foreground font-medium truncate">
                    {m.companyName}
                  </span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => { addToScannerShelf(m.ticker); navigate("/options-scanner"); }}
                className="flex items-center gap-1 text-[11px] font-medium text-white bg-green-600 hover:bg-green-500 rounded-md px-2.5 py-1 transition-colors shrink-0"
              >
                <LineChart className="w-3 h-3" /> Open Options
              </button>

              <div className="text-right shrink-0">
                <div className="flex items-baseline justify-end gap-2">
                  <span className="text-2xl font-bold font-mono tracking-tight">
                    {m.currentPrice != null ? `$${m.currentPrice.toFixed(2)}` : "—"}
                  </span>
                  <span
                    className={cn(
                      "flex items-center gap-1 text-sm font-mono font-semibold",
                      dayUp ? "text-green-400" : "text-red-400",
                    )}
                  >
                    {dayUp ? (
                      <TrendingUp className="w-3.5 h-3.5" />
                    ) : (
                      <TrendingDown className="w-3.5 h-3.5" />
                    )}
                    {dayUp ? "+" : ""}
                    {m.dayChange?.toFixed(2)} ({dayUp ? "+" : ""}
                    {((m.dayChangePercent ?? 0) * 100).toFixed(2)}%)
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {m.exchange && (
                <TagBadge type="exchange" value={m.exchange} matches={tagMatchesFor("exchange", m.exchange)} onSelectTicker={commitTicker} />
              )}
              {m.sector && (
                <TagBadge type="sector" value={m.sector} matches={tagMatchesFor("sector", m.sector)} onSelectTicker={commitTicker} />
              )}
              {m.industry && (
                <TagBadge type="industry" value={m.industry} matches={tagMatchesFor("industry", m.industry)} onSelectTicker={commitTicker} />
              )}
              {m.stockType && (
                <TagBadge type="stockType" value={m.stockType} matches={tagMatchesFor("stockType", m.stockType)} onSelectTicker={commitTicker} />
              )}
              {m.beta != null && (
                <TagBadge type="beta" value={`Beta ${formatNumber(m.beta)}`} />
              )}
              {m.fairValueEstimate != null && (
                <FairValueBadge
                  fairValue={m.fairValueEstimate} low={m.fairValueLow} high={m.fairValueHigh}
                  confidence={m.fairValueConfidence} impliedGrowth={m.fairValueImpliedGrowth}
                  votes={m.fairValueVotes} asOf={m.fairValueAsOf} price={m.currentPrice} change3m={m.fairValueChange3m} cyclical={m.fairValueCyclical} valueTrap={m.fairValueValueTrap}
                />
              )}
              {m.marketCap != null && (
                <TagBadge type="marketCap" value={`Mkt Cap ${formatLargeNumber(m.marketCap)}`} />
              )}
            </div>

            {/* ── Memo header: fund model + trade overlay ── */}
            {(() => {
              const se = data.scoreEvidence;
              const tr = data.tradeOverlay;
              const catalysts = data.catalysts ?? [];
              const earns = catalysts.find((l) => /^(Earnings|Next earnings)/i.test(l));
              const hasCases =
                catalysts.some((l) => !/^(Earnings|Next earnings)/i.test(l)) ||
                (data.bullBullets?.length ?? 0) > 0 ||
                (data.bearBullets?.length ?? 0) > 0;
              return (
                <div id="bd-memo-header" className="mt-0.5 space-y-1.5">
                  {/* Our peer-relative fund model — not the Street (WRDS/LSEG) panel below */}
                  <div className="bg-zinc-950 border border-[#d4af37]/25 rounded-lg px-2.5 py-2 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-[#d4af37]" title="Peer-relative fundamentals — separate from Street (WRDS/LSEG) below">
                        Our Fund
                      </span>
                      <span className="text-base leading-none" title="Peer-relative fundamental score (0–100)">
                        <ScoreBadge score={se?.modelScore ?? se?.total} max={100} />
                      </span>
                      {se?.activeAdjPoints ? (
                        <span className="text-[11px] font-mono text-amber-200" title="model + active desk adj">
                          <span className="font-semibold">Desk</span>{" "}
                          <span className="font-bold">{se.deskScore != null ? se.deskScore.toFixed(0) : "—"}</span>
                          <span className="text-amber-100/80 ml-1 italic">
                            (adj {se.activeAdjPoints >= 0 ? "+" : ""}{se.activeAdjPoints})
                          </span>
                        </span>
                      ) : null}
                      <PillarChip label="V" score={se?.value} title="Value pillar" />
                      <PillarChip label="G" score={se?.growth} title="Growth pillar" />
                      <PillarChip label="Q" score={se?.quality} title="Quality pillar" />
                      <PillarChip label="S" score={se?.safety} title="Safety pillar" />
                      {se?.style && (
                        <span className="text-[10px] font-semibold italic px-1.5 py-0.5 rounded border border-violet-400/60 text-violet-200 bg-violet-500/20">
                          {se.style}
                        </span>
                      )}
                      {se?.confidence && (
                        <span className="text-[10px] font-semibold text-sky-200 underline decoration-sky-500/50 underline-offset-2">
                          {se.confidence} conf
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-[#d4af37]/15 pt-1.5">
                      <span className="text-[9px] font-bold uppercase tracking-wider text-sky-300">Trade</span>
                      {tr?.techScore != null && (
                        <PillarChip label="Tech" score={tr.techScore} title="Technical score" />
                      )}
                      {tr?.ivVsRealized != null && (
                        <span className="text-[11px] font-mono font-bold tabular-nums text-white px-1.5 py-0.5 rounded border border-sky-400/50 bg-sky-500/15">
                          IV/RV {tr.ivVsRealized.toFixed(2)}
                        </span>
                      )}
                      {tr?.atmPutIv != null && (
                        <span className="text-[11px] font-mono font-bold tabular-nums text-white px-1.5 py-0.5 rounded border border-cyan-400/50 bg-cyan-500/15">
                          IV {tr.atmPutIv.toFixed(0)}%
                        </span>
                      )}
                      {(tr?.earningsDaysOut != null || earns) && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-yellow-500/25 text-yellow-200 border-yellow-400/60">
                          {tr?.earningsDaysOut != null ? `ER ${tr.earningsDaysOut}d` : earns}
                        </span>
                      )}
                      {tr?.streetEventRisk && (
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-red-400/70 text-red-200 bg-red-500/20">
                          Event risk
                        </span>
                      )}
                      {!tr?.techScore && tr?.ivVsRealized == null && tr?.atmPutIv == null && !tr?.earningsDaysOut && !earns && !tr?.streetEventRisk && (
                        <span className="text-[10px] text-amber-100/70 italic">No trade overlay yet</span>
                      )}
                    </div>
                  </div>
                  {hasCases && (
                    <div id="bd-cases">
                      <BullBearCases
                        bullBullets={data.bullBullets ?? []}
                        bearBullets={data.bearBullets ?? []}
                        catalysts={catalysts}
                      />
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ── Score evidence (model families) ── */}
            <BreakdownMetricsTable
              groups={[
                {
                  title: "Value",
                  sectionId: "bd-family-value",
                  score: data.scoreEvidence?.value ?? null,
                  rows: [
                    { label: "P/E Ratio", value: formatNumber(m.peRatio) },
                    { label: "PEG Ratio", value: formatNumber(m.pegRatio), good: m.pegRatio != null ? m.pegRatio < 1.5 : undefined },
                    { label: "Price / Book", value: formatNumber(m.priceToBook) },
                    { label: "Price / Sales", value: formatNumber(m.priceToSales) },
                    ...(m.analystTargetPrice != null
                      ? [{ label: "Analyst Target", value: formatCurrency(m.analystTargetPrice) }]
                      : []),
                    ...(m.analystTargetPrice != null && m.currentPrice != null
                      ? [{
                          label: "Upside to Target",
                          value: `${((m.analystTargetPrice / m.currentPrice - 1) * 100).toFixed(1)}%`,
                          good: m.analystTargetPrice > m.currentPrice,
                        }]
                      : []),
                    ...((data.scoreEvidence?.topMetrics ?? [])
                      .filter((t) => t.family === "value")
                      .slice(0, 2)
                      .map((t) => ({
                        label: `${t.key}${t.peerPct != null ? ` p${t.peerPct}` : ""}`,
                        value: t.raw != null ? formatNumber(t.raw) : "—",
                      }))),
                  ],
                },
                {
                  title: "Growth",
                  sectionId: "bd-family-growth",
                  score: data.scoreEvidence?.growth ?? null,
                  rows: [
                    { label: "Revenue Growth (YoY)", value: formatPercent(m.revenueGrowthYoY), good: m.revenueGrowthYoY != null ? m.revenueGrowthYoY > 0 : undefined },
                    { label: "EPS Growth", value: formatPercent(m.epsGrowth), good: m.epsGrowth != null ? m.epsGrowth > 0 : undefined },
                    {
                      label: "PEG growth (peer z)",
                      value: m.pegGrowth != null
                        ? `${formatPercent(m.pegGrowth)}${
                            m.pegGrowthPeerZ != null
                              ? ` · ${m.pegGrowthPeerZ >= 0 ? "+" : ""}${(m.pegGrowthPeerZ as number).toFixed(1)}σ`
                              : ""
                          }`
                        : "—",
                      good: m.pegGrowthPeerZ != null
                        ? (m.pegGrowthPeerZ as number) >= 0.5
                          ? true
                          : (m.pegGrowthPeerZ as number) <= -0.5
                            ? false
                            : undefined
                        : m.pegGrowth != null
                          ? m.pegGrowth > 0
                          : undefined,
                    },
                    { label: "Forward P/E", value: formatNumber(m.forwardPe) },
                    ...((data.scoreEvidence?.topMetrics ?? [])
                      .filter((t) => t.family === "growth")
                      .slice(0, 2)
                      .map((t) => ({
                        label: `${t.key}${t.peerPct != null ? ` p${t.peerPct}` : ""}`,
                        value: t.raw != null ? formatNumber(t.raw) : "—",
                      }))),
                  ],
                },
                {
                  title: "Quality",
                  sectionId: "bd-family-quality",
                  score: data.scoreEvidence?.quality ?? null,
                  rows: [
                    { label: "Return on Equity", value: formatPercent(m.returnOnEquity), good: m.returnOnEquity != null ? m.returnOnEquity > 0.1 : undefined },
                    { label: "Gross Margin", value: formatPercent(m.grossMargin) },
                    { label: "Operating Margin", value: formatPercent(m.operatingMargin) },
                    { label: "Net Margin", value: formatPercent(m.netMargin), good: m.netMargin != null ? m.netMargin > 0.08 : undefined },
                    { label: "Free Cash Flow", value: formatLargeNumber(m.freeCashFlow) },
                    ...((data.scoreEvidence?.topMetrics ?? [])
                      .filter((t) => t.family === "quality")
                      .slice(0, 2)
                      .map((t) => ({
                        label: `${t.key}${t.peerPct != null ? ` p${t.peerPct}` : ""}`,
                        value: t.raw != null ? formatNumber(t.raw) : "—",
                      }))),
                  ],
                },
                {
                  title: "Safety",
                  sectionId: "bd-family-safety",
                  score: data.scoreEvidence?.safety ?? null,
                  rows: [
                    { label: "Current Ratio", value: formatNumber(m.currentRatio), good: m.currentRatio != null ? m.currentRatio > 1.5 : undefined },
                    { label: "Debt / Equity", value: formatNumber(m.debtToEquity), good: m.debtToEquity != null ? m.debtToEquity < 0.5 : undefined },
                    { label: "Beta", value: formatNumber(m.beta) },
                    { label: "Dividend Yield", value: formatPercent(m.dividendYield), good: m.dividendYield != null && m.dividendYield > 0 ? true : undefined },
                    ...((data.scoreEvidence?.topMetrics ?? [])
                      .filter((t) => t.family === "safety")
                      .slice(0, 2)
                      .map((t) => ({
                        label: `${t.key}${t.peerPct != null ? ` p${t.peerPct}` : ""}`,
                        value: t.raw != null ? formatNumber(t.raw) : "—",
                      }))),
                  ],
                },
              ]}
            />

            {/* ── Price chart + Technicals dig ── */}
            <div className="space-y-1">
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => setTvOpen(true)}
                  className="text-[10px] font-semibold text-amber-200/60 hover:text-[#d4af37] underline underline-offset-2 decoration-[#d4af37]/30"
                >
                  Technicals
                </button>
              </div>
              <div className="h-[340px] w-full min-w-0">
                <PriceChart
                  tickers={[m.ticker]}
                  loadedStocks={[m]}
                  selectedPeriod={chartPeriod}
                  onPeriodChange={setChartPeriod}
                  showTechnicalZones={!!propTicker}
                  tickerForTechnicals={propTicker}
                  compact
                />
              </div>
            </div>

            {/* ── Priority stack ── */}
            {(() => {
              const hasPeers = !!activeTicker;
              const hasNews = !!data.news && data.news.some((n) => !!n.link);
              const hasEarnings = !!data.earningsHistory && data.earningsHistory.length > 0;
              const hasGrowth =
                m.pegGrowth != null &&
                m.pegGrowthPeerMean != null &&
                m.pegGrowthPeerStd != null &&
                (m.pegGrowthPeerDisplay?.length ?? m.pegGrowthPeerMembers?.length ?? 0) >= 2;
              const hasAnalyst = !!data.recommendations;
              const hasSentiment = !!data.recommendations;
              const hasHistory = (data.scoreHistory?.length ?? 0) > 0;

              return (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2 items-stretch">
                    <BreakdownPanel
                      title="Peers (relative scores)"
                      empty="No peer group data."
                      scrollMax="h-[280px]"
                      action={
                        isAdmin ? (
                          <button
                            type="button"
                            onClick={() => setPeerEditOpen((v) => !v)}
                            className="text-[10px] text-amber-200/60 hover:text-[#d4af37]"
                          >
                            {peerEditOpen ? "Close editor" : "Edit group"}
                          </button>
                        ) : undefined
                      }
                    >
                      {hasPeers ? (
                        <div id="bd-peers" className="space-y-2">
                          <CompetitorsSection
                            ticker={activeTicker!}
                            compact
                            onSelectTicker={commitTicker}
                          />
                          {isAdmin && peerEditOpen && (
                            <div className="border-t border-[#d4af37]/15 pt-2">
                              <PeerGroupEditor ticker={m.ticker} compact />
                            </div>
                          )}
                        </div>
                      ) : null}
                    </BreakdownPanel>

                    <BreakdownPanel
                      title="Street"
                      empty="No Street synthesis yet."
                      scrollMax="h-[280px] overflow-hidden flex flex-col"
                    >
                      {activeTicker ? (
                        <div id="bd-street" className="h-full min-h-0 flex flex-col">
                          <StreetSynthesisCard street={data.street} ticker={activeTicker} />
                        </div>
                      ) : null}
                    </BreakdownPanel>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <BreakdownPanel title="Analyst Ratings" empty="No analyst ratings yet." scrollMax="h-[280px]">
                      {hasAnalyst ? (
                        <AnalystRatingsSection
                          recs={data.recommendations!}
                          metrics={m}
                          analystActions={data.analystActions ?? []}
                          analystPriceTargets={data.analystPriceTargets ?? []}
                          priceTargetRange={data.priceTargetRange ?? null}
                        />
                      ) : null}
                    </BreakdownPanel>

                    <BreakdownPanel title="Earnings" empty="No earnings history yet." scrollMax="h-[280px]">
                      {hasEarnings ? (
                        <EarningsHistorySection history={data.earningsHistory ?? []} compact />
                      ) : null}
                    </BreakdownPanel>

                    <BreakdownPanel title="Growth (PEG)" empty="Peer growth sample unavailable." scrollMax="max-h-[260px]">
                      {hasGrowth ? (
                        <PegGrowthDistChart
                          mean={m.pegGrowthPeerMean}
                          std={m.pegGrowthPeerStd}
                          subjectGrowth={m.pegGrowth}
                          subjectZ={m.pegGrowthPeerZ ?? null}
                          pegGrowthSource={m.pegGrowthSource}
                          pegGrowthExplain={m.pegGrowthExplain}
                          display={m.pegGrowthPeerDisplay ?? m.pegGrowthPeerMembers ?? []}
                          members={m.pegGrowthPeerMembers ?? m.pegGrowthPeerDisplay ?? []}
                          groupName={m.pegGrowthPeerGroup}
                        />
                      ) : null}
                    </BreakdownPanel>

                    <BreakdownPanel title="Sentiment" empty="No Wall St. consensus yet." scrollMax="max-h-[260px]">
                      {hasSentiment ? (
                        <MarketSentimentSection recs={data.recommendations} />
                      ) : null}
                    </BreakdownPanel>

                    {/* News / Score history / Accounting — one dig panel with sub-tabs */}
                    <div
                      id="bd-dig"
                      className="col-span-2 bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-2.5 flex flex-col min-h-0"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5 shrink-0">
                        <div className="flex items-center gap-0.5 rounded border border-[#d4af37]/20 p-0.5">
                          {(
                            [
                              ["news", "News"],
                              ["history", "Score history"],
                              ["accounting", "Accounting"],
                            ] as const
                          ).map(([id, label]) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setDigTab(id)}
                              className={cn(
                                "text-[10px] font-semibold px-2 py-0.5 rounded transition-colors",
                                digTab === id
                                  ? "bg-[#d4af37]/20 text-[#d4af37]"
                                  : "text-amber-200/50 hover:text-amber-100",
                              )}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        {digTab === "history" && isAdmin && activeTicker ? (
                          <ScoreNoteForm ticker={activeTicker} />
                        ) : null}
                      </div>
                      <div className="min-h-0 max-h-[320px] overflow-y-auto">
                        {digTab === "news" && (
                          hasNews ? (
                            <div id="bd-narrative" className="space-y-0.5 -mx-0.5">
                              {data.news.filter((n) => n.link).slice(0, 8).map((item, i) => (
                                <NewsCard key={i} item={item} compact />
                              ))}
                            </div>
                          ) : (
                            <p className="text-[10px] text-amber-200/40 italic">No recent news.</p>
                          )
                        )}
                        {digTab === "history" && (
                          hasHistory || isAdmin ? (
                            <div id="bd-score-history">
                              <FundScoreHistoryChart history={data.scoreHistory ?? []} />
                            </div>
                          ) : (
                            <p className="text-[10px] text-amber-200/40 italic">No score history yet.</p>
                          )
                        )}
                        {digTab === "accounting" && activeTicker && (
                          <AccountingStatementsSection ticker={activeTicker} />
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Technicals — centered dialog (same pattern as WRDS/LSEG) */}
            <Dialog open={tvOpen} onOpenChange={setTvOpen}>
              <DialogContent
                className={cn(
                  "bg-zinc-950 border-[#d4af37]/30 text-zinc-100",
                  "w-[calc(100vw-1.5rem)] sm:max-w-2xl md:max-w-3xl",
                  "max-h-[85dvh] p-0 gap-0 flex flex-col overflow-hidden",
                )}
              >
                <DialogHeader className="px-4 pt-4 pb-2 border-b border-[#d4af37]/15 shrink-0 space-y-1 text-left">
                  <DialogTitle className="text-[#d4af37] text-base tracking-tight">
                    Technicals · {m.ticker}
                  </DialogTitle>
                  <DialogDescription className="text-zinc-500 text-[11px]">
                    TradingView technical summary — open when you need the dig, not in the main path.
                  </DialogDescription>
                </DialogHeader>
                <div className="flex-1 min-h-0 overflow-hidden p-2">
                  <TradingViewTechnicalWidget
                    ticker={m.ticker}
                    exchange={m.exchange}
                    height={560}
                    zoom={1}
                  />
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>

    </div>
  );
}
