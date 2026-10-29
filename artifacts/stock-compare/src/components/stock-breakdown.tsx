import { useState, useRef, useCallback, useEffect } from "react";
import { useLocation } from "wouter";
import {
  Loader2, Search, AlertCircle, BarChart2, TrendingUp, TrendingDown, LineChart,
} from "lucide-react";
import { PriceChart, Period } from "./price-chart";
import { TradingViewTechnicalWidget } from "./tradingview-technical-widget";
import { CompetitorsSection, useCompetitors } from "./competitors-section";
import { AnalystRatingsSection } from "./analyst-ratings-section";
import { EarningsHistorySection, earningsBeatAction } from "./earnings-history-section";
import { DeskSentimentSection } from "./desk-sentiment-section";
import { AccountingStatementsSection } from "./accounting-statements-section";
import { NewsCard } from "./news-card";
import { BreakdownMetricsTable } from "./breakdown-metrics-table";
import { PegGrowthDistChart } from "./peg-growth-dist-chart";
import { PeerGroupEditor } from "./settings/PeerGroupEditor";
import { FundScoreHistoryChart } from "./fund-score-history-chart";
import { StreetHeaderBadges, StreetSynthesisCard } from "./street-synthesis-card";
import { ScoreNoteForm } from "./score-note-form";
import { StockNotesPanel } from "./breakdown/stock-notes-panel";
import { useAuth } from "@/context/AuthContext";
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react";
import { useDebounce } from "@/hooks/use-debounce";
import { cn } from "@/lib/utils";
import { subTabClass } from "@/lib/sub-tabs";
import { formatCurrency, formatGrowthYoY, formatLargeNumber, formatNumber, formatPercent } from "@/lib/format";
import { addToScannerShelf, optionsScannerHref } from "@/lib/ticker-shelf-storage";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { ModelThesisReport, type ModelThesis } from "@/components/model-thesis-report";
import { FairValueBadge } from "@/components/fair-value-badge";
import { OutsideValuesBox } from "@/components/breakdown/outside-values-box";
import { LazyMount } from "@/components/lazy-mount";

import {
  useBreakdown, overviewBullets, TagBadge, BreakdownPanel, TAG_STYLES,
  type ClassificationTagType, type WatchlistTagEntry,
} from "./breakdown/stock-breakdown-parts";
import { MemoHeader } from "./breakdown/memo-header";
import { BreakdownMetaProvider } from "./breakdown/breakdown-meta-context";
import { formatDerivedTip, formatProvenanceTip } from "@/lib/provenance-display";
import { DataTip } from "./data-tip";
import { ShortInterestPanel, ShortInterestHeaderStats } from "./breakdown/short-interest-panel";
import { InsiderPanel, InsiderHeaderStats } from "./breakdown/insider-panel";
import { EventsPanel } from "./breakdown/events-panel";
import { EarningsCallPanel, EarningsCallsTab } from "./breakdown/earnings-call-panel";
import { OptionsHistoryTab } from "./breakdown/options-history-tab";
import { AssumptionsTab } from "./breakdown/assumptions-tab";
import { ThesisTab } from "./breakdown/thesis-tab";
import { useFundamentalsProvenance } from "@/hooks/use-fundamentals-provenance";
import { provFieldForScoreKey } from "@/lib/provenance-display";
import { scoreMetricUi } from "@/lib/fund-score-treatments";

/** Keys already shown as static rows in each family — skip so we don't repeat "EPS Grow" + epsgrow. */
const STATIC_SCORE_KEYS: Record<string, Set<string>> = {
  value: new Set(["peg", "ps", "pb", "fwdpe", "divy", "upside"]),
  growth: new Set(["revgrow", "epsgrow", "upside"]),
  quality: new Set(["roe", "grossmgn", "operatingmgn", "netmgn"]),
  safety: new Set(["cr", "de", "beta", "divy"]),
};

function topScoreMetricRow(t: {
  key: string;
  raw: number | null;
  peerPct: number | null;
}) {
  const { label, tip } = scoreMetricUi(t.key);
  const peer = t.peerPct != null ? ` · p${t.peerPct}` : "";
  return {
    label,
    tip:
      tip
      + (t.peerPct != null
        ? ` Peer percentile p${t.peerPct} (100 = best vs peers on this metric).`
        : ""),
    value: t.raw != null ? `${formatNumber(t.raw)}${peer}` : "—",
    fieldKey: provFieldForScoreKey(t.key),
  };
}

function extraTopMetrics(family: string, top: Array<{ key: string; family: string; raw: number | null; peerPct: number | null }> | undefined) {
  const skip = STATIC_SCORE_KEYS[family] ?? new Set();
  return (top ?? [])
    .filter((t) => t.family === family && !skip.has(t.key))
    .slice(0, 2)
    .map(topScoreMetricRow);
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
  const [digTab, setDigTab] = useState<"news" | "notes" | "history" | "accounting" | "assumptions" | "thesis" | "calls" | "options">("news");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [focusedIdx, setFocusedIdx] = useState(-1);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  const jumpToTop = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = 0;
    // Layout after async breakdown body can re-anchor mid-page — pin again next frames.
    requestAnimationFrame(() => {
      el.scrollTop = 0;
      requestAnimationFrame(() => { el.scrollTop = 0; });
    });
  }, []);

  // When driven by watchlist / Model List click, sync ticker from prop and jump to top
  // (kept mid-scroll from the previous name hides MODEL THESIS above the fold).
  useEffect(() => {
    if (propTicker) {
      setActiveTicker(propTicker);
      setInputText(propTicker);
      setChartPeriod("1W");
      jumpToTop();
    }
  }, [propTicker, jumpToTop]);

  useEffect(() => {
    if (modelThesis) jumpToTop();
  }, [modelThesis, jumpToTop]);

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

  const { data, isLoading, isFetching, error } = useBreakdown(activeTicker);
  const { data: peersMeta } = useCompetitors(activeTicker ?? "");
  const { byField: provByField } = useFundamentalsProvenance(activeTicker);

  // Breakdown body arriving below the thesis triggers CSS overflow-anchor → header
  // scrolls off the top (Jamie: "can't scroll up to MODEL THESIS"). Re-pin when data lands.
  useEffect(() => {
    if (modelThesis && data && !isLoading) jumpToTop();
  }, [modelThesis, data, isLoading, jumpToTop]);

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
    <div className="h-full min-h-0 flex flex-col overflow-hidden" data-lenis-prevent>
      {/* Search header — hidden when ticker is driven by parent (e.g. watchlist) */}
      {!propTicker && <div className="shrink-0 border-b border-[#d4af37]/20 bg-zinc-900/95 backdrop-blur px-6 py-3 z-10">
        <div className="max-w-5xl mx-auto flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-100/80 pointer-events-none z-10" />
            {isSearching && debouncedQuery.length >= 1 && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-amber-100/80 animate-spin z-10" />
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
              className="w-full h-10 pl-9 pr-9 text-sm font-mono bg-white border border-white/20 text-black placeholder:text-amber-100/80 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary transition-colors"
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
                    <span className="text-amber-100/80 text-xs truncate ml-2 max-w-[180px]">
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

      {/* Content area — min-h-0 + data-lenis-prevent so nested scroll works under A127 Lenis */}
      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto overscroll-contain [overflow-anchor:none]"
        data-lenis-prevent
      >
        {/* Empty state */}
        {!activeTicker && (
          <div className="h-full flex flex-col items-center justify-center text-center text-amber-100/70 gap-4 py-20">
            <div className="w-16 h-16 rounded-2xl bg-secondary/50 flex items-center justify-center border border-dashed border-border">
              <BarChart2 className="w-8 h-8" />
            </div>
            <div>
              <p className="text-sm font-medium">Enter a ticker to get the full breakdown</p>
              <p className="text-xs mt-1 text-amber-100/60">
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
        {activeTicker && isLoading && !data && (
          <div className="flex items-center justify-center py-16">
            <div className="flex flex-col items-center gap-3 text-amber-100/80">
              <Loader2 className="w-8 h-8 animate-spin" />
              <span className="text-sm">Loading {activeTicker}…</span>
            </div>
          </div>
        )}

        {/* SWR: cached body stays up; thin bar while a fresh fetch runs */}
        {activeTicker && isFetching && !!data && (
          <div className="sticky top-0 z-20 h-0.5 bg-[#d4af37]/30 overflow-hidden">
            <div className="h-full w-1/3 bg-[#d4af37] animate-pulse" />
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
          <BreakdownMetaProvider
            byField={provByField}
            score={data?.scoreEvidence}
            trade={data?.tradeOverlay}
            quote={{ source: m.priceSource ?? null, asOf: m.priceAsOf ?? null }}
          >
          <div className="max-w-5xl mx-auto px-5 py-4 space-y-3 pb-8">
            {/* ── Header ── */}
            <div className="flex items-center justify-between gap-3 min-w-0">
              <div className="min-w-0 flex-1 flex items-baseline gap-2 whitespace-nowrap overflow-hidden">
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
                      <p className="text-xs text-amber-100/70">No description available.</p>
                    )}
                  </PopoverContent>
                </Popover>
                {m.companyName ? (
                  <span
                    className="text-[11px] text-amber-100/80 font-medium truncate min-w-0"
                    title={m.companyName}
                  >
                    {m.companyName}
                  </span>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => { addToScannerShelf(m.ticker); navigate(optionsScannerHref(m.ticker)); }}
                className="flex items-center gap-1 text-[11px] font-medium text-white bg-green-600 hover:bg-green-500 rounded-md px-2.5 py-1 transition-colors shrink-0"
              >
                <LineChart className="w-3 h-3" /> Open Options
              </button>

              <div className="text-right shrink-0">
                <div className="flex items-baseline justify-end gap-2">
                  <DataTip
                    tip={formatDerivedTip({
                      label: "Last",
                      kind: "sourced",
                      source: m.priceSource ? `${m.priceSource} (live ≤60s)` : "Schwab→Yahoo live ≤60s",
                      asOf: m.priceAsOf ?? null,
                    })}
                  >
                    <span className="text-2xl font-bold font-mono tracking-tight">
                      {m.currentPrice != null ? `$${m.currentPrice.toFixed(2)}` : "—"}
                    </span>
                  </DataTip>
                  {m.dayChange != null && m.dayChangePercent != null ? (
                    <DataTip
                      tip={formatDerivedTip({
                        label: "Day chg",
                        kind: "sourced",
                        source: m.priceSource ? `${m.priceSource} (live ≤60s)` : "Schwab→Yahoo live ≤60s",
                        asOf: m.priceAsOf ?? null,
                      })}
                    >
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
                        {m.dayChange.toFixed(2)} ({dayUp ? "+" : ""}
                        {(m.dayChangePercent * 100).toFixed(2)}%)
                      </span>
                    </DataTip>
                  ) : (
                    <span className="text-sm font-mono text-amber-100/70">—</span>
                  )}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 mt-1.5">
              {/* Exchange (NasdaqGM etc.) hidden — not useful for peers; venue is noise on US names. */}
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
                <TagBadge
                  type="beta"
                  value={`Beta ${formatNumber(m.beta)}`}
                  title={formatProvenanceTip(provByField.get("beta"))
                    ?? formatDerivedTip({ label: "Beta", kind: "sourced", source: "fundamentals merge", asOf: data?.scoreEvidence?.inputsAsOf })}
                />
              )}
              {m.fairValueEstimate != null && (
                <FairValueBadge
                  ticker={m.ticker}
                  fairValue={m.fairValueEstimate} low={m.fairValueLow} high={m.fairValueHigh}
                  confidence={m.fairValueConfidence} impliedGrowth={m.fairValueImpliedGrowth}
                  votes={m.fairValueVotes} asOf={m.fairValueAsOf} price={m.currentPrice} change3m={m.fairValueChange3m} cyclical={m.fairValueCyclical} valueTrap={m.fairValueValueTrap}
                />
              )}
              {m.marketCap != null && (
                <TagBadge
                  type="marketCap"
                  value={`Mkt Cap ${formatLargeNumber(m.marketCap)}`}
                  title={formatProvenanceTip(provByField.get("marketCap"))
                    ?? formatDerivedTip({ label: "Market cap", kind: "sourced", source: "fundamentals / quote", asOf: data?.scoreEvidence?.inputsAsOf })}
                />
              )}
            </div>

            {m.fairValueEstimate != null && m.ticker && (
              <OutsideValuesBox ticker={m.ticker} price={m.currentPrice} votes={m.fairValueVotes} />
            )}

            {/* ── Memo header: fund model + trade overlay (ETF → yield/AUM strip) ── */}
            <MemoHeader data={data} />

            {/* ── Score evidence (model families) — skip for ETFs (empty stock pillars) ── */}
            {!data?.etfProfile && <BreakdownMetricsTable
              byField={provByField}
              metrics={m}
              groups={[
                {
                  title: "Value",
                  sectionId: "bd-family-value",
                  score: data.scoreEvidence?.value ?? null,
                  rows: [
                    { label: "P/E", tip: "Price ÷ trailing earnings.", value: formatNumber(m.peRatio), fieldKey: "peRatio" },
                    { label: "PEG", tip: "P/E ÷ expected growth. Under ~1.5 often looks cheap vs growth.", value: formatNumber(m.pegRatio), good: m.pegRatio != null ? m.pegRatio < 1.5 : undefined, fieldKey: "pegRatio" },
                    { label: "P/B", tip: "Price ÷ book value per share.", value: formatNumber(m.priceToBook), fieldKey: "priceToBook" },
                    { label: "P/S", tip: "Price ÷ sales (revenue) per share.", value: formatNumber(m.priceToSales), fieldKey: "priceToSales" },
                    ...(m.pegTtm != null ? [{ label: "PEG TTM", tip: "Trailing PEG (Finnhub pegTTM). Not the derived gold PEG.", value: formatNumber(m.pegTtm), fieldKey: "pegTtm" }] : []),
                    ...(m.priceToFcf != null ? [{ label: "P/FCF", tip: "Price ÷ free cash flow (FMP).", value: formatNumber(m.priceToFcf), fieldKey: "priceToFcf" }] : []),
                    ...(m.fcfYield != null ? [{ label: "FCF Yld", tip: "Free cash flow ÷ price (FMP).", value: formatPercent(m.fcfYield), fieldKey: "fcfYield" }] : []),
                    ...(m.priceToTbv != null ? [{ label: "P/TBV", tip: "Price ÷ tangible book (Finnhub).", value: formatNumber(m.priceToTbv), fieldKey: "priceToTbv" }] : []),
                    ...(m.analystTargetPrice != null
                      ? [{ label: "Target", tip: "Street consensus price target.", value: formatCurrency(m.analystTargetPrice), fieldKey: "analystTargetPrice", isEstimate: true }]
                      : []),
                    ...(m.analystTargetPrice != null && m.currentPrice != null
                      ? [{
                          label: "Upside",
                          tip: "Implied upside from price to street target.",
                          value: `${((m.analystTargetPrice / m.currentPrice - 1) * 100).toFixed(1)}%`,
                          good: m.analystTargetPrice > m.currentPrice,
                          fieldKey: "analystTargetPrice",
                          isEstimate: true,
                        }]
                      : []),
                    ...extraTopMetrics("value", data.scoreEvidence?.topMetrics),
                  ],
                },
                {
                  title: "Growth",
                  sectionId: "bd-family-growth",
                  score: data.scoreEvidence?.growth ?? null,
                  rows: [
                    { label: "Rev YoY", tip: "Year-over-year revenue growth (fraction: 1.0 = 100%).", value: formatGrowthYoY(m.revenueGrowthYoY), good: m.revenueGrowthYoY != null ? m.revenueGrowthYoY > 0 : undefined, fieldKey: "revenueGrowthYoY" },
                    { label: "EPS Grow", tip: "Year-over-year EPS growth.", value: formatPercent(m.epsGrowth), good: m.epsGrowth != null ? m.epsGrowth > 0 : undefined, fieldKey: "epsGrowth" },
                    {
                      label: "PEG z",
                      tip: m.pegGrowthPeerZ != null
                        ? `PEG-implied growth vs peers · z=${(m.pegGrowthPeerZ as number) >= 0 ? "+" : ""}${(m.pegGrowthPeerZ as number).toFixed(1)}σ (see Growth PEG panel).`
                        : "PEG-implied growth vs peers (σ = peer z-score).",
                      // σ lives in tip + Growth panel — packing it here overflows into Quality.
                      value: m.pegGrowth != null ? formatPercent(m.pegGrowth) : "—",
                      good: m.pegGrowthPeerZ != null
                        ? (m.pegGrowthPeerZ as number) >= 0.5
                          ? true
                          : (m.pegGrowthPeerZ as number) <= -0.5
                            ? false
                            : undefined
                        : m.pegGrowth != null
                          ? m.pegGrowth > 0
                          : undefined,
                      fieldKey: "pegRatio",
                    },
                    { label: "Fwd P/E", tip: "Price ÷ forward (next-year) EPS estimate.", value: formatNumber(m.forwardPe), fieldKey: "forwardPe", isEstimate: true },
                    ...(m.epsGrowth5Y != null ? [{ label: "EPS 5y", tip: "5-year EPS growth (Finnhub). Fraction: 0.12 = 12%.", value: formatGrowthYoY(m.epsGrowth5Y), fieldKey: "epsGrowth5Y" }] : []),
                    ...(m.revenueGrowth5Y != null ? [{ label: "Rev 5y", tip: "5-year revenue growth (Finnhub).", value: formatGrowthYoY(m.revenueGrowth5Y), fieldKey: "revenueGrowth5Y" }] : []),
                    ...extraTopMetrics("growth", data.scoreEvidence?.topMetrics),
                  ],
                },
                {
                  title: "Quality",
                  sectionId: "bd-family-quality",
                  score: data.scoreEvidence?.quality ?? null,
                  rows: [
                    { label: "ROE", tip: "Return on equity: net income ÷ shareholder equity.", value: formatPercent(m.returnOnEquity), good: m.returnOnEquity != null ? m.returnOnEquity > 0.1 : undefined, fieldKey: "returnOnEquity" },
                    { label: "Gross Mgn", tip: "Gross profit ÷ revenue.", value: formatPercent(m.grossMargin), fieldKey: "grossMargin" },
                    { label: "Op Mgn", tip: "Operating income ÷ revenue.", value: formatPercent(m.operatingMargin), fieldKey: "operatingMargin" },
                    { label: "Net Mgn", tip: "Net income ÷ revenue.", value: formatPercent(m.netMargin), good: m.netMargin != null ? m.netMargin > 0.08 : undefined, fieldKey: "netMargin" },
                    { label: "FCF", tip: "Free cash flow (cash from ops after capex).", value: formatLargeNumber(m.freeCashFlow), fieldKey: "freeCashFlow" },
                    ...(m.incomeQuality != null ? [{ label: "Inc Qual", tip: "Income quality: operating cash flow ÷ net income (FMP).", value: formatNumber(m.incomeQuality), fieldKey: "incomeQuality" }] : []),
                    ...(m.sbcToRevenue != null ? [{ label: "SBC/Rev", tip: "Stock-based compensation ÷ revenue (FMP).", value: formatPercent(m.sbcToRevenue), fieldKey: "sbcToRevenue" }] : []),
                    ...(m.payoutRatio != null ? [{ label: "Payout", tip: "Dividend payout ratio.", value: formatPercent(m.payoutRatio), fieldKey: "payoutRatio" }] : []),
                    ...extraTopMetrics("quality", data.scoreEvidence?.topMetrics),
                  ],
                },
                {
                  title: "Safety",
                  sectionId: "bd-family-safety",
                  score: data.scoreEvidence?.safety ?? null,
                  rows: [
                    { label: "Curr Rat", tip: "Current assets ÷ current liabilities.", value: formatNumber(m.currentRatio), good: m.currentRatio != null ? m.currentRatio > 1.5 : undefined, fieldKey: "currentRatio" },
                    { label: "D/E", tip: "Total debt ÷ equity. Lower = less leverage.", value: formatNumber(m.debtToEquity), good: m.debtToEquity != null ? m.debtToEquity < 0.5 : undefined, fieldKey: "debtToEquity" },
                    { label: "Beta", tip: "Equity beta vs the market (volatility).", value: formatNumber(m.beta), fieldKey: "beta" },
                    { label: "Div Yld", tip: "Annual dividend ÷ price.", value: formatPercent(m.dividendYield), good: m.dividendYield != null && m.dividendYield > 0 ? true : undefined, fieldKey: "dividendYield" },
                    ...(m.interestCoverage != null ? [{ label: "Int Cov", tip: "Interest coverage (EBIT ÷ interest). Higher = easier debt service.", value: formatNumber(m.interestCoverage), fieldKey: "interestCoverage" }] : []),
                    ...extraTopMetrics("safety", data.scoreEvidence?.topMetrics),
                  ],
                },
                ...(m.tier1CapitalRatio != null || m.totalCapitalRatio != null || m.rotce != null || m.netInterestIncome != null || m.totalDeposits != null
                  ? [{
                      title: "Banks",
                      sectionId: "bd-family-banks",
                      score: null as number | null,
                      rows: [
                        ...(m.tier1CapitalRatio != null ? [{ label: "Tier 1", tip: "Tier 1 capital ratio. FactSet RATIO is percent points (15.2 = 15.2%), not divided by 100.", value: `${formatNumber(m.tier1CapitalRatio)}%`, fieldKey: "tier1CapitalRatio" }] : []),
                        ...(m.totalCapitalRatio != null ? [{ label: "Tot Cap", tip: "Total capital ratio. FactSet RATIO, percent points.", value: `${formatNumber(m.totalCapitalRatio)}%`, fieldKey: "totalCapitalRatio" }] : []),
                        ...(m.rotce != null ? [{ label: "ROTCE", tip: "Return on tangible equity. FactSet PERCENTAGE, stored as a fraction.", value: formatPercent(m.rotce), fieldKey: "rotce" }] : []),
                        ...(m.tangibleBookValuePerShare != null ? [{ label: "TBV", tip: "Tangible book value per share (dollars).", value: formatCurrency(m.tangibleBookValuePerShare), fieldKey: "tangibleBookValuePerShare" }] : []),
                        ...(m.netInterestIncome != null ? [{ label: "NII", tip: "Net interest income. FactSet FIN scale 6 (millions → dollars).", value: formatLargeNumber(m.netInterestIncome), fieldKey: "netInterestIncome" }] : []),
                        ...(m.totalDeposits != null ? [{ label: "Deposits", tip: "Total deposits. FactSet FIN scale 6 (millions → dollars).", value: formatLargeNumber(m.totalDeposits), fieldKey: "totalDeposits" }] : []),
                      ],
                    }]
                  : []),
              ]}
            />}

            {/* ── Price chart + Technicals dig (A182: defer mount / history fetch) ── */}
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
              <LazyMount
                minHeight={380}
                rootMargin="320px 0px"
                fallback={
                  <div className="h-[380px] w-full min-w-0 rounded-lg border border-[#d4af37]/15 bg-zinc-950/80 flex items-center justify-center text-[10px] text-amber-100/70">
                    Chart · scroll to load
                  </div>
                }
              >
                <div className="h-[380px] w-full min-w-0 min-h-0 overflow-hidden">
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
              </LazyMount>
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
              const hasSentiment = !!activeTicker;
              const hasHistory = (data.scoreHistory?.length ?? 0) > 0;

              return (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2 items-stretch">
                    <BreakdownPanel
                      title={
                        <>
                          <span className="shrink-0">Peers</span>
                          {(peersMeta?.groupName || peersMeta?.industry) && (
                            <span
                              className={cn(
                                "text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border truncate max-w-[14rem]",
                                TAG_STYLES.industry,
                              )}
                              title={peersMeta.groupName ?? peersMeta.industry ?? undefined}
                            >
                              {peersMeta.groupName ?? peersMeta.industry}
                            </span>
                          )}
                        </>
                      }
                      empty="No peer group data."
                      scrollMax="h-[300px]"
                      action={
                        isAdmin ? (
                          <button
                            type="button"
                            onClick={() => setPeerEditOpen((v) => !v)}
                            className="text-[10px] text-amber-200/60 hover:text-[#d4af37] shrink-0"
                          >
                            {peerEditOpen ? "Close editor" : "Edit group"}
                          </button>
                        ) : undefined
                      }
                    >
                      {hasPeers ? (
                        <div id="bd-peers" className="space-y-2 min-w-0 h-full">
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
                      scrollMax="h-[300px]"
                      action={<StreetHeaderBadges street={data.street} />}
                    >
                      {activeTicker ? (
                        <div id="bd-street" className="min-h-0 h-full">
                          <StreetSynthesisCard street={data.street} ticker={activeTicker} />
                        </div>
                      ) : null}
                    </BreakdownPanel>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <BreakdownPanel title="Analyst Ratings" empty="No analyst ratings yet." scrollMax="h-[280px] overflow-x-auto overflow-y-auto">
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

                    <BreakdownPanel
                      title="Earnings"
                      empty="No earnings history yet."
                      scrollMax="min-h-0 max-h-[280px] overflow-y-auto"
                      action={hasEarnings ? earningsBeatAction(data.earningsHistory) : undefined}
                    >
                      {hasEarnings ? (
                        <EarningsHistorySection history={data.earningsHistory ?? []} compact />
                      ) : null}
                    </BreakdownPanel>

                    <BreakdownPanel title="Growth (PEG)" empty="Peer growth sample unavailable." scrollMax="max-h-[260px] overflow-hidden">
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

                    <BreakdownPanel title="Sentiment" empty="No desk sentiment yet." scrollMax="max-h-[260px]">
                      {hasSentiment ? (
                        <DeskSentimentSection ticker={activeTicker!} news={data.news} />
                      ) : null}
                    </BreakdownPanel>

                    <BreakdownPanel
                      title="Short interest"
                      empty="No short-interest data."
                      scrollMax="max-h-[260px]"
                      action={activeTicker ? <ShortInterestHeaderStats ticker={activeTicker} /> : undefined}
                    >
                      {activeTicker ? <ShortInterestPanel ticker={activeTicker} /> : null}
                    </BreakdownPanel>

                    <BreakdownPanel
                      title="Insiders"
                      empty="No Form 4 buys or sales."
                      scrollMax="max-h-[260px]"
                      action={activeTicker ? <InsiderHeaderStats ticker={activeTicker} /> : undefined}
                    >
                      {activeTicker ? <InsiderPanel ticker={activeTicker} /> : null}
                    </BreakdownPanel>

                    <BreakdownPanel
                      title={
                        <DataTip tip="SEC 8-K disclosure categories (Polygon). Analyst upgrades/PTs live in Analyst Ratings + Bull/Bear catalysts — not here.">
                          <span className="cursor-help border-b border-dotted border-[#d4af37]/50">8-K Events</span>
                        </DataTip>
                      }
                      empty="No 8-K events."
                      scrollMax="max-h-[260px]"
                    >
                      {activeTicker ? <EventsPanel ticker={activeTicker} /> : null}
                    </BreakdownPanel>

                    <BreakdownPanel title="Earnings call" empty="No call summary yet." scrollMax="max-h-[260px]">
                      {activeTicker ? <EarningsCallPanel ticker={activeTicker} /> : null}
                    </BreakdownPanel>

                    {/* News / Score history / Accounting — one dig panel with sub-tabs */}
                    <div
                      id="bd-dig"
                      className="col-span-2 bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-2.5 flex flex-col min-h-0"
                    >
                      <div className="flex items-center justify-between gap-2 mb-1.5 shrink-0">
                        <div className="flex items-center gap-0.5 flex-wrap">
                          {(
                            [
                              ["news", "News", "sky"],
                              ["notes", "Notes", "emerald"],
                              ["history", "Score history", "violet"],
                              ["accounting", "Accounting", "amber"],
                              ["assumptions", "Assumptions", "orange"],
                              ["thesis", "Thesis", "emerald"],
                              ["calls", "Earnings calls", "rose"],
                              ["options", "Options history", "gold"],
                            ] as const
                          ).map(([id, label, hue]) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setDigTab(id)}
                              className={subTabClass(digTab === id, hue)}
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
                            <p className="text-[10px] text-amber-100/70 italic">No recent news.</p>
                          )
                        )}
                        {digTab === "history" && (
                          hasHistory || isAdmin ? (
                            <div id="bd-score-history">
                              <FundScoreHistoryChart history={data.scoreHistory ?? []} />
                            </div>
                          ) : (
                            <p className="text-[10px] text-amber-100/70 italic">No score history yet.</p>
                          )
                        )}
                        {digTab === "accounting" && activeTicker && (
                          <AccountingStatementsSection ticker={activeTicker} />
                        )}
                        {digTab === "assumptions" && activeTicker && <AssumptionsTab ticker={activeTicker} />}
                        {digTab === "thesis" && activeTicker && <ThesisTab ticker={activeTicker} />}
                        {digTab === "notes" && activeTicker && <StockNotesPanel ticker={activeTicker} isAdmin={!!isAdmin} />}
                        {digTab === "calls" && activeTicker && <EarningsCallsTab ticker={activeTicker} />}
                        {digTab === "options" && activeTicker && <OptionsHistoryTab ticker={activeTicker} isAdmin={!!isAdmin} />}
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
                  <DialogDescription className="text-amber-100/80 text-[11px]">
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
          </BreakdownMetaProvider>
        )}
      </div>

    </div>
  );
}
