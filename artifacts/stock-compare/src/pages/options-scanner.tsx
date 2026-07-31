import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { TopNav } from "@/components/top-nav";
import { cn } from "@/lib/utils";
import { useWatchlist } from "@/hooks/use-watchlist";
import {
  computeTechnicalRankingsV2,
  type TechnicalRow,
  type TechnicalScore,
} from "@/lib/technical-rankings";
import { Loader2, RefreshCw, TrendingUp, Search } from "lucide-react";
import { pickBestStrike, type StockContext } from "@/lib/option-scorer";
import { computeRelativeMove, computeStockScore } from "@/lib/stock-scorer";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { useTrackRecordTilt } from "@/hooks/use-track-record-tilt";
import { CredibilityBadge } from "@/components/credibility-badge";
import { CALL_STRIKE_WEIGHTS } from "@/lib/option-scorer-constants";
import { useAuth } from "@/context/AuthContext";
import { queryKeys } from "@/lib/query-keys";
import { getTraderPrefs, saveTraderPrefs } from "@/lib/trader-prefs";
import {
  pfNum,
  RED_TAG,
  SortableHeader,
  type OptionRow,
  type OptionsChainResult,
  type MacroRegimeResult,
  type ScorecardRow,
  type SortKey,
} from "@/components/options-scanner/options-scanner-types";
import { minutesAgo } from "@/components/options-scanner/options-scanner-helpers";
import { ScannerRow } from "@/components/options-scanner/options-scanner-row";

// Scoped per user so multiple accounts on the same browser don't inherit each
// other's hidden scanner tickers (mirrors colorKey in use-watchlist.ts)
function scannerHiddenKey(userId: number | undefined): string {
  return userId ? `fildi_scanner_hidden_${userId}` : "fildi_scanner_hidden";
}

// ── Main Page ─────────────────────────────────────────────────────────────────

// DOM id for an optional host element (e.g. rendered inline in a tab bar by a parent page)
// that the min-income filter portals into instead of its own default control row.
export const OPTIONS_FILTER_SLOT_ID = "options-filter-bar-slot";

export function OptionsScannerContent({ showHeader = true }: { showHeader?: boolean }) {
  const { isAdmin, user } = useAuth();
  const { weights, hasCustomOptionStrike } = useScoringPreferences();
  const { data: tilt } = useTrackRecordTilt();

  // sessionStorage (not localStorage) — expanded rows are tab-lifetime UI state,
  // restored on returning to this tab/sub-tab, but not meant to persist forever.
  const [expandedSet,   setExpandedSet]   = useState<Set<string>>(() => {
    try { const s = sessionStorage.getItem("fildi_scanner_expanded"); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });
  const [refreshedOptions, setRefreshedOptions] = useState<Map<string, OptionsChainResult[]>>(new Map());
  const [overrides,     setOverrides]     = useState<Set<string>>(new Set());
  const [sort,          setSort]          = useState<SortKey>("optionScore");
  // Sell Puts vs. Sell Calls — a page-level mode, not a per-row sub-tab, so the whole
  // table (scores, sort, expanded strike view) is scoped consistently to one side at a time.
  const [scanMode,      setScanMode]      = useState<"puts" | "calls">(() => {
    try { return (localStorage.getItem("fildi_scanner_mode") as "puts" | "calls") || "puts"; } catch { return "puts"; }
  });
  const isCallMode = scanMode === "calls";
  useEffect(() => { try { localStorage.setItem("fildi_scanner_mode", scanMode); } catch {} }, [scanMode]);
  // Model auto-tilt applies only to untouched defaults; an explicit user override always wins.
  const effectiveStrikeWeights = isCallMode
    ? (tilt?.call.weights ?? CALL_STRIKE_WEIGHTS)
    : (hasCustomOptionStrike ? weights.optionStrike : (tilt?.put.weights ?? weights.optionStrike));
  const [minIncome,     setMinIncome]     = useState(() => getTraderPrefs(user?.id).minWeeklyIncome);
  const [minIncomeInput, setMinIncomeInput] = useState(() => String(getTraderPrefs(user?.id).minWeeklyIncome));
  const [tickerQuery,   setTickerQuery]   = useState("");
  const [refreshedAt,   setRefreshedAt]   = useState(() => new Date());
  const [hiddenTickers, setHiddenTickers] = useState<Set<string>>(() => {
    try { const s = localStorage.getItem(scannerHiddenKey(user?.id)); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });

  // Reload from the new user's key on account switch (covers login/logout without a full page reload)
  useEffect(() => {
    try { const s = localStorage.getItem(scannerHiddenKey(user?.id)); setHiddenTickers(s ? new Set(JSON.parse(s)) : new Set()); } catch { setHiddenTickers(new Set()); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => { localStorage.setItem(scannerHiddenKey(user?.id), JSON.stringify([...hiddenTickers])); }, [hiddenTickers, user?.id]);
  useEffect(() => { saveTraderPrefs({ minWeeklyIncome: minIncome }, user?.id); }, [minIncome, user?.id]);
  useEffect(() => { try { sessionStorage.setItem("fildi_scanner_expanded", JSON.stringify([...expandedSet])); } catch {} }, [expandedSet]);

  // If a parent page (e.g. the Fundamentals/Technicals/Options tab bar in rankings.tsx)
  // renders a host element with this id, portal the filter control there instead of
  // showing it in this component's own control row.
  const [filterSlot, setFilterSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setFilterSlot(document.getElementById(OPTIONS_FILTER_SLOT_ID)); }, []);

  const { entries, isLoaded } = useWatchlist();

  const activeTickers = useMemo(
    () => entries.filter(e => e.colorTag !== RED_TAG).map(e => e.ticker),
    [entries],
  );
  const colorMap = useMemo(
    () => new Map(entries.map(e => [e.ticker, e.colorTag])),
    [entries],
  );

  // Watchlist tickers minus hidden
  const displayTickers = useMemo(
    () => activeTickers.filter(t => !hiddenTickers.has(t)),
    [activeTickers, hiddenTickers],
  );

  // ── V2 technicals — all 31 rows for self-relative scoring ───────────────────
  const { data: allTechnicalsData } = useQuery({
    queryKey: ["technicals", "all"],
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all");
      if (!res.ok) throw new Error("technicals/all fetch failed");
      return res.json();
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  // ── Scorecard batch — watchlist tickers (for display: RSI, MFI, IV, price) ─
  const { data: scorecardData, isLoading: scorecardLoading, refetch: refetchScorecard } = useQuery({
    queryKey:             ["technical-scorecard"],
    queryFn:              async () => {
      const res = await fetch("/api/technical/scorecard");
      if (!res.ok) throw new Error("scorecard fetch failed");
      return res.json() as Promise<ScorecardRow[]>;
    },
    staleTime:            Infinity,
    refetchOnWindowFocus: false,
  });

  // ── Options — one batched request for all display tickers ───────────────────
  // Every sort key (income/buffer/otm/optionScore) is computed FROM the options
  // chain, so there's no way to lazy-load "just the top N" — the ranking itself
  // depends on having every ticker's chain. Batching avoids an N-way parallel
  // burst against Yahoo; the server caps concurrency and reuses optionsCache.
  const displayTickersKey = useMemo(() => [...displayTickers].sort().join(","), [displayTickers]);

  const { data: batchOptionsData, isFetching: batchOptionsFetching } = useQuery({
    queryKey:             ["options-batch", displayTickersKey],
    queryFn:              async () => {
      const res = await fetch(`/api/options/batch?tickers=${encodeURIComponent(displayTickersKey)}`);
      if (!res.ok) throw new Error("options batch fetch failed");
      return res.json() as Promise<Record<string, OptionsChainResult[] | { error: string }>>;
    },
    enabled:              isLoaded && displayTickers.length > 0,
    staleTime:            5 * 60_000,
    refetchOnWindowFocus: false,
  });

  // ── Derived maps ─────────────────────────────────────────────────────────────
  const scorecardMap = useMemo(
    () => new Map((scorecardData ?? []).map(r => [r.ticker, r])),
    [scorecardData],
  );

  const optionsMap = useMemo(() => {
    const m = new Map<string, OptionsChainResult[] | null>();
    displayTickers.forEach(t => {
      const refreshed = refreshedOptions.get(t);
      if (refreshed) { m.set(t, refreshed); return; }
      const entry = batchOptionsData?.[t];
      m.set(t, entry && !("error" in entry) ? entry : null);
    });
    return m;
  }, [displayTickers, batchOptionsData, refreshedOptions]);

  const optionsLoadingMap = useMemo(() => {
    const m = new Map<string, boolean>();
    displayTickers.forEach(t => {
      const hasData = refreshedOptions.has(t) || !!batchOptionsData?.[t];
      m.set(t, batchOptionsFetching && !hasData);
    });
    return m;
  }, [displayTickers, batchOptionsFetching, batchOptionsData, refreshedOptions]);

  // ── Volatility regime (VIX-band, intraday) — for Option Scorer overlay ───────
  // Distinct from the business-cycle "macro-regime" used on home.tsx.
  const { data: macroRegimeData } = useQuery({
    queryKey: ["volatility", "regime"],
    queryFn: async (): Promise<MacroRegimeResult> => {
      const res = await fetch("/api/volatility/regime");
      if (!res.ok) return { vix: null, spxChange1d: null, ndxChange1d: null, rutChange1d: null, regime: "BASELINE", indexDirection: "NEUTRAL", error: "fetch failed" };
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  // ── Fundamental rankings — for Option Scorer stock quality component ──────────
  const { data: fundRankingsData } = useQuery({
    queryKey: queryKeys.fundamentalsRankings,
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const res = await fetch("/api/fundamentals/rankings");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  // V2: self-relative scores over all 31 watchlist rows — invariant to display filter.
  // Side-aware: call mode scores overbought/exhaustion/extension (sell calls into
  // strength) instead of the put-side oversold/reversal components.
  const rankings = useMemo(() => {
    if (!allTechnicalsData?.length) return new Map<string, TechnicalScore>();
    return new Map(
      computeTechnicalRankingsV2(allTechnicalsData, {}, weights.technical, isCallMode ? "call" : "put")
        .map(s => [s.ticker, s]),
    );
  }, [allTechnicalsData, weights.technical, isCallMode]);

  // Tech row map (full fields for Option Scorer — includes swingLow, pivotS1, atr14, etc.)
  const techRowMap = useMemo(
    () => new Map((allTechnicalsData ?? []).map(r => [r.ticker, r])),
    [allTechnicalsData],
  );

  // Fundamental score map
  const fundScoreMap = useMemo(
    () => new Map((fundRankingsData ?? []).map(r => [r.ticker, r.totalScore])),
    [fundRankingsData],
  );

  // Cross-watchlist IVs for absolute IV component (from all loaded option chains)
  const allWatchlistIVs = useMemo(() => {
    const ivs: number[] = [];
    for (const chains of optionsMap.values()) {
      if (!chains) continue;
      for (const c of chains) for (const p of c.puts) if (p.iv > 0) ivs.push(p.iv);
    }
    return ivs;
  }, [optionsMap]);

  // Best option per ticker (drives optionScore/Income%/Buffer sort + column display).
  // All three columns must come off the SAME picked strike from pickBestStrike —
  // previously Income%/Buffer independently re-scanned every strike for its own max,
  // which could land on a different strike/expiry than the one actually scored.
  const { bestOptionScoreMap, bestIncomeMap, bufferMap } = useMemo(() => {
    const scoreMap = new Map<string, number>();
    const incomeMap = new Map<string, number>();
    const bufMap = new Map<string, number>();
    for (const ticker of displayTickers) {
      const chains = optionsMap.get(ticker);
      const techRow = techRowMap.get(ticker);
      if (!chains || !techRow) continue;
      const stockCtx: StockContext = {
        ivRank:                pfNum(techRow.ivRank),
        ivPercentile:          pfNum(techRow.ivPercentile),
        ivVsRealizedVol:       pfNum(techRow.ivVsRealizedVol),
        basicSkew:             pfNum(techRow.basicSkew),
        swingLow20d:           pfNum(techRow.swingLow20d),
        swingLow50d:           pfNum(techRow.swingLow50d),
        pivotS1:               pfNum(techRow.pivotS1),
        swingHigh20d:          pfNum(techRow.swingHigh20d),
        swingHigh50d:          pfNum(techRow.swingHigh50d),
        pivotR1:               pfNum(techRow.pivotR1),
        nearestSupportDistPct: pfNum(techRow.nearestSupportDistPct),
        techTotalScore:        rankings.get(ticker)?.totalScore ?? null,
        fundTotalScore:        fundScoreMap.get(ticker) ?? null,
      };
      const picked = pickBestStrike(
        chains.map(c => ({ ...c, options: isCallMode ? c.calls : c.puts })),
        stockCtx, macroRegimeData?.regime ?? "BASELINE", allWatchlistIVs, undefined,
        effectiveStrikeWeights, isCallMode,
      );
      if (!picked) continue;
      scoreMap.set(ticker, picked.result.optionScore);
      incomeMap.set(ticker, picked.result.weeklyIncome);
      const spot = picked.chain.spot ?? 0;
      const exactDte = picked.chain.exactDte ?? Math.max(1, picked.chain.daysToExpiry);
      if (spot > 0 && picked.put.iv > 0 && exactDte > 0) {
        const otm = isCallMode ? (picked.put.strike - spot) / spot : (spot - picked.put.strike) / spot;
        bufMap.set(ticker, otm / (picked.put.iv * Math.sqrt(exactDte / 365)));
      }
    }
    return { bestOptionScoreMap: scoreMap, bestIncomeMap: incomeMap, bufferMap: bufMap };
  }, [displayTickers, optionsMap, techRowMap, rankings, fundScoreMap, macroRegimeData, allWatchlistIVs, effectiveStrikeWeights, isCallMode]);

  // Stock Score per ticker (drives "Stock Score" sort — combines tech + fund + relMove + bestOption + tag)
  const stockScoreMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const ticker of displayTickers) {
      const techRow   = techRowMap.get(ticker);
      const indicator = scorecardMap.get(ticker);
      const chains    = optionsMap.get(ticker);
      const relMove   = computeRelativeMove(
        pfNum(techRow?.priceZScore),
        pfNum(techRow?.priceVsMa50Atr),
        indicator?.return5d ?? null,
        pfNum(techRow?.swingHigh20d),
        pfNum(techRow?.swingLow20d),
        chains?.[0]?.spot ?? null,
        isCallMode ? "call" : "put",
      );
      const result = computeStockScore({
        techTotalScore:    rankings.get(ticker)?.totalScore ?? null,
        fundTotalScore:    fundScoreMap.get(ticker) ?? null,
        relativeMoveScore: relMove,
        bestOptionScore:   bestOptionScoreMap.get(ticker) ?? null,
        colorTag:          colorMap.get(ticker) ?? null,
      }, weights.optionStock);
      m.set(ticker, result.stockScore);
    }
    return m;
  }, [displayTickers, techRowMap, scorecardMap, optionsMap, rankings, fundScoreMap, bestOptionScoreMap, colorMap, weights.optionStock, isCallMode]);

  // ── Sort + filter ─────────────────────────────────────────────────────────────
  // Re-sorts whenever the score map behind the active sort key actually changes
  // (e.g. options/technicals data finishes loading) — previously this read stale
  // snapshots via refs, which froze row order at whatever (mostly-empty) scores
  // existed on first render and never converged to match the displayed values.
  const sortedTickers = useMemo(() => {
    const optMap     = optionsMap;
    const bestScores  = bestOptionScoreMap;
    const stockScores = stockScoreMap;
    const scorecard   = scorecardMap;
    const incomeMap   = bestIncomeMap;
    const bufMap      = bufferMap;

    let list = [...displayTickers];

    list.sort((a, b) => {
      switch (sort) {
        case "optionScore":
          return (bestScores.get(b) ?? -1) - (bestScores.get(a) ?? -1);
        case "score":
          return (stockScores.get(b) ?? 0) - (stockScores.get(a) ?? 0);
        case "iv": {
          const iv = (t: string) => scorecard.get(t)?.ivCurrent ?? -1;
          return iv(b) - iv(a);
        }
        case "buffer":
          return (bufMap.get(b) ?? -1) - (bufMap.get(a) ?? -1);
        case "otm": {
          const otm = (t: string) => {
            const chains = optMap.get(t);
            if (!chains) return -1;
            const spot = chains[0]?.spot ?? 0;
            const strikes = chains.flatMap((c: OptionsChainResult) => (isCallMode ? c.calls : c.puts).filter((p: OptionRow) => p.meetsGate).map((p: OptionRow) => p.strike));
            if (spot <= 0 || strikes.length === 0) return -1;
            const best = isCallMode ? Math.min(...strikes) : Math.max(...strikes);
            return isCallMode ? ((best - spot) / spot) * 100 : ((spot - best) / spot) * 100;
          };
          return otm(b) - otm(a);
        }
        case "income":
        default:
          return (incomeMap.get(b) ?? -1) - (incomeMap.get(a) ?? -1);
      }
    });
    return list;
  }, [displayTickers, sort, optionsMap, bestOptionScoreMap, stockScoreMap, scorecardMap, bestIncomeMap, bufferMap, isCallMode]);

  const filteredTickers = useMemo(() => {
    const q = tickerQuery.trim().toLowerCase();
    return q ? sortedTickers.filter(t => t.toLowerCase().includes(q)) : sortedTickers;
  }, [sortedTickers, tickerQuery]);

  // ── Handlers ──────────────────────────────────────────────────────────────────
  const handleExpand = (ticker: string) => {
    setExpandedSet(prev => {
      const next = new Set(prev);
      next.has(ticker) ? next.delete(ticker) : next.add(ticker);
      return next;
    });
  };

  const handleRowRefresh = async (ticker: string) => {
    try {
      const res = await fetch(`/api/options/${ticker}`);
      if (!res.ok) throw new Error(`options refresh failed: ${ticker}`);
      const data = await res.json() as OptionsChainResult[];
      setRefreshedOptions(prev => new Map(prev).set(ticker, data));
    } catch {
      // keep existing data on failure
    }
  };

  const handleOverride = (ticker: string) => {
    setOverrides(prev => new Set([...prev, ticker]));
  };

  const handleDelete = (ticker: string) => {
    setHiddenTickers(prev => new Set([...prev, ticker]));
    setExpandedSet(prev => { const n = new Set(prev); n.delete(ticker); return n; });
    setOverrides(prev => { const n = new Set(prev); n.delete(ticker); return n; });
  };

  const handleGlobalRefresh = () => {
    refetchScorecard();
    setRefreshedAt(new Date());
  };

  // ── Render ────────────────────────────────────────────────────────────────────

  // Editable min-income filter — hides strikes that return less than this % per week.
  // Portals into the parent tab bar when embedded in rankings.tsx (see filterSlot above);
  // falls back to rendering inline above the table when used standalone (e.g. /options-scanner).
  const filterBar = (
    <div
      className="flex items-center gap-1.5 border border-emerald-500/30 bg-emerald-500/5 rounded-full pl-2.5 pr-1 h-7"
      title="Minimum weekly return filter — hides option strikes that yield less than this % of the strike price per week"
    >
      <TrendingUp className="w-3 h-3 text-emerald-400 shrink-0" />
      <span className="text-xs text-white whitespace-nowrap">Min %/wk</span>
      <input
        type="number"
        min="0"
        step="0.1"
        value={minIncomeInput}
        onChange={e => {
          setMinIncomeInput(e.target.value);
          const n = parseFloat(e.target.value);
          if (Number.isFinite(n) && n >= 0) setMinIncome(n);
        }}
        className="w-10 text-xs bg-transparent text-foreground focus:outline-none text-center font-mono"
      />
    </div>
  );

  const tickerFilterBar = (
    <div className="relative">
      <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2 top-1/2 -translate-y-1/2" />
      <input
        type="text"
        value={tickerQuery}
        onChange={e => setTickerQuery(e.target.value)}
        placeholder="Filter ticker..."
        className="h-7 w-36 pl-7 pr-2 text-xs rounded-md border border-white/20 bg-white text-black placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary"
      />
    </div>
  );

  // Sell Puts / Sell Calls — swaps the whole table (scores, sort, expanded strikes) to
  // the other side. Both are served from the same already-fetched per-ticker options
  // batch (optionsCache on the server), so switching never triggers a network request.
  const scanModeToggle = (
    <div className="flex items-center rounded-full border border-border/60 bg-slate-900/40 p-0.5 text-xs h-7 shrink-0">
      <button
        onClick={() => setScanMode("puts")}
        className={cn(
          "px-2.5 h-6 rounded-full transition-colors font-semibold",
          !isCallMode ? "bg-primary/20 text-primary" : "text-white/70 hover:text-white",
        )}
      >
        Sell Puts
      </button>
      <button
        onClick={() => setScanMode("calls")}
        className={cn(
          "px-2.5 h-6 rounded-full transition-colors font-semibold",
          isCallMode ? "bg-primary/20 text-primary" : "text-white/70 hover:text-white",
        )}
      >
        Sell Calls
      </button>
    </div>
  );

  const controlsRow = (
    <div className="flex items-center gap-2">
      {scanModeToggle}
      <CredibilityBadge side={isCallMode ? "call" : "put"} />
      {filterBar}
      {tickerFilterBar}
    </div>
  );

  return (
    <div className="space-y-4">
        {showHeader && <h1 className="text-xl font-bold">Options Scanner</h1>}

        {/* Controls — hidden here and portaled into the tab bar when filterSlot is present */}
        {!filterSlot && (
          <div className="flex items-center gap-2 flex-wrap">
            {controlsRow}
          </div>
        )}
        {filterSlot && createPortal(controlsRow, filterSlot)}

        {/* Scanner table */}
        {scorecardLoading || !isLoaded ? (
          <div className="flex items-center gap-2 text-sm text-white py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading scorecard…
          </div>
        ) : filteredTickers.length === 0 ? (
          <div className="text-sm text-white py-8 text-center">
            No tickers match current filters.
          </div>
        ) : (
          <div className="rounded-md border border-border overflow-hidden">
            {/* Column headers */}
            <div className="flex items-center gap-2 px-3 py-1 border-b border-border bg-slate-900/80 text-xs font-bold tracking-wider uppercase text-white" style={{ borderLeft: "4px solid transparent" }}>
              <div className="w-[70px] shrink-0">Ticker</div>
              <div className="w-[80px] shrink-0">Price</div>
              <div className="w-[56px] shrink-0">Signal</div>
              <div className="w-[48px] shrink-0" title="Hover a row's RSI value for full reasoning">RSI</div>
              <SortableHeader label="Option Score" sortKey="optionScore" active={sort === "optionScore"} width="w-[90px]" onClick={setSort} />
              <SortableHeader label="Stock Score" sortKey="score" active={sort === "score"} width="w-[90px]" onClick={setSort} />
              <SortableHeader label="IV%" sortKey="iv" active={sort === "iv"} width="w-[52px]" onClick={setSort} />
              <SortableHeader label="Income%" sortKey="income" active={sort === "income"} width="w-[72px]" onClick={setSort} />
              <SortableHeader label="Buffer" sortKey="buffer" active={sort === "buffer"} width="w-[64px]" onClick={setSort} />
              <div className="flex-1" />
              {isAdmin && (
                <button
                  className="flex items-center gap-1.5 text-xs normal-case font-normal tracking-normal text-white transition-colors shrink-0"
                  onClick={handleGlobalRefresh}
                  disabled={scorecardLoading}
                >
                  {scorecardLoading
                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <RefreshCw className="w-3.5 h-3.5" />
                  }
                  {minutesAgo(refreshedAt)}
                </button>
              )}
            </div>
            {filteredTickers.map(ticker => (
              <ScannerRow
                key={ticker}
                ticker={ticker}
                colorTag={colorMap.get(ticker) ?? ""}
                indicator={scorecardMap.get(ticker) ?? null}
                score={rankings.get(ticker) ?? null}
                optionsData={optionsMap.get(ticker) ?? null}
                optionsLoading={optionsLoadingMap.get(ticker) ?? false}
                expanded={expandedSet.has(ticker)}
                minIncome={minIncome}
                overrideEnabled={overrides.has(ticker)}
                onExpand={() => handleExpand(ticker)}
                onRefresh={isAdmin ? () => handleRowRefresh(ticker) : undefined}
                onDelete={() => handleDelete(ticker)}
                onOverride={() => handleOverride(ticker)}
                techRow={techRowMap.get(ticker) ?? null}
                fundTotalScore={fundScoreMap.get(ticker) ?? null}
                macroRegime={macroRegimeData?.regime ?? "BASELINE"}
                allWatchlistIVs={allWatchlistIVs}
                strikeWeights={effectiveStrikeWeights}
                bestOptionScore={bestOptionScoreMap.get(ticker) ?? null}
                bestIncome={bestIncomeMap.get(ticker) ?? null}
                bestBuffer={bufferMap.get(ticker) ?? null}
                stockScore={stockScoreMap.get(ticker) ?? null}
                isCall={isCallMode}
              />
            ))}
          </div>
        )}
    </div>
  );
}

export default function OptionsScanner() {
  return (
    <div className="min-h-screen bg-background">
      <TopNav />
      <main className="pt-14 p-6 space-y-4">
        <OptionsScannerContent />
      </main>
    </div>
  );
}
