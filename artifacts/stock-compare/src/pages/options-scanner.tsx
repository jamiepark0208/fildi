import { useState, useMemo, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TopNav } from "@/components/top-nav";
import { cn } from "@/lib/utils";
import { useWatchlist } from "@/hooks/use-watchlist";
import {
  type TechnicalRow,
  type TechnicalScore,
} from "@/lib/technical-rankings";
import { Loader2, RefreshCw, TrendingUp, Search, Trophy, Settings2 } from "lucide-react";
import { pickBestStrike, selectPremiumCandidates, type StockContext } from "@/lib/option-scorer";
import { computeRelativeMove, computeStockScore } from "@/lib/stock-scorer";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { useTrackRecordTilt } from "@/hooks/use-track-record-tilt";
import { useModelList, modelAvoidTickers } from "@/hooks/use-model-list";
import { CredibilityBadge } from "@/components/credibility-badge";
import { CALL_STRIKE_WEIGHTS } from "@/lib/option-scorer-constants";
import { useAuth } from "@/context/AuthContext";
import { queryKeys } from "@/lib/query-keys";
import { getTraderPrefs, saveTraderPrefs } from "@/lib/trader-prefs";
import { formatMdYy } from "@/lib/format";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  pfNum,
  RED_TAG,
  SortableHeader,
  OPTIONS_BOARD_COLS,
  colRange,
  type OptionRow,
  type OptionsChainResult,
  type MacroRegimeResult,
  type ScorecardRow,
  type SortKey,
} from "@/components/options-scanner/options-scanner-types";
import { minutesAgo } from "@/components/options-scanner/options-scanner-helpers";
import { ScannerRow } from "@/components/options-scanner/options-scanner-row";
import { useMoverFacts } from "@/hooks/use-mover-facts";

// Scoped per user so multiple accounts on the same browser don't inherit each
// other's hidden scanner tickers (mirrors colorKey in use-watchlist.ts)
function scannerHiddenKey(userId: number | undefined): string {
  return userId ? `fildi_scanner_hidden_${userId}` : "fildi_scanner_hidden";
}

// ── Main Page ─────────────────────────────────────────────────────────────────

// DOM id for an optional host element (e.g. rendered inline in a tab bar by a parent page)
// that the min-income filter portals into instead of its own default control row.
export const OPTIONS_FILTER_SLOT_ID = "options-filter-bar-slot";

export function OptionsScannerContent({
  showHeader = true,
  universe = "watchlist",
  side: controlledSide,
  onSideChange,
}: {
  showHeader?: boolean;
  /** Watchlist = user tickers; Overall = premium-IV candidates (same scorer + expandables). */
  universe?: "watchlist" | "overall";
  /** When set, parent owns Sell Puts/Calls (stable rankings chrome). */
  side?: "puts" | "calls";
  onSideChange?: (side: "puts" | "calls") => void;
}) {
  const { isAdmin, user } = useAuth();
  const queryClient = useQueryClient();
  const { weights, hasCustomOptionStrike } = useScoringPreferences();
  const { data: tilt } = useTrackRecordTilt();
  const sideControlled = controlledSide != null;

  // sessionStorage (not localStorage) — expanded rows are tab-lifetime UI state,
  // restored on returning to this tab/sub-tab, but not meant to persist forever.
  const [expandedSet,   setExpandedSet]   = useState<Set<string>>(() => {
    try { const s = sessionStorage.getItem("fildi_scanner_expanded"); return s ? new Set(JSON.parse(s)) : new Set(); } catch { return new Set(); }
  });
  const [refreshedOptions, setRefreshedOptions] = useState<Map<string, OptionsChainResult[]>>(new Map());
  /** Chain fetch failed / timed out — clears infinite "Loading options…" spinner. */
  const [chainFailed, setChainFailed] = useState<Map<string, string>>(new Map());
  const [overrides,     setOverrides]     = useState<Set<string>>(new Set());
  const [sort,          setSort]          = useState<SortKey>("optionScore");
  // Sell Puts vs. Sell Calls — a page-level mode, not a per-row sub-tab, so the whole
  // table (scores, sort, expanded strike view) is scoped consistently to one side at a time.
  const [scanMode,      setScanMode]      = useState<"puts" | "calls">(() => {
    try { return (localStorage.getItem("fildi_scanner_mode") as "puts" | "calls") || "puts"; } catch { return "puts"; }
  });
  const effectiveMode = sideControlled ? controlledSide! : scanMode;
  const isCallMode = effectiveMode === "calls";
  const setMode = (m: "puts" | "calls") => {
    if (sideControlled) onSideChange?.(m);
    else setScanMode(m);
  };
  useEffect(() => {
    if (!sideControlled) {
      try { localStorage.setItem("fildi_scanner_mode", scanMode); } catch {}
    }
  }, [scanMode, sideControlled]);
  // Model auto-tilt applies only to untouched defaults; an explicit user override always wins.
  const tiltSide = isCallMode ? tilt?.call : tilt?.put;
  const effectiveStrikeWeights = isCallMode
    ? (tilt?.call.weights ?? CALL_STRIKE_WEIGHTS)
    : (hasCustomOptionStrike ? weights.optionStrike : (tilt?.put.weights ?? weights.optionStrike));
  const pickOpts = useMemo(() => ({
    minStockQuality: tiltSide?.sqFloor,
    calibration: tilt?.calibration ?? null,
    earningsHaircut: tiltSide?.earningsHaircut,
  }), [tiltSide?.sqFloor, tiltSide?.earningsHaircut, tilt?.calibration]);
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

  const { entries, isLoaded: watchlistLoaded } = useWatchlist();

  // ── Slim technicals (StockContext / relativeMove) + side-aware V2 totals ─
  // Raw rows live in DB; put/call totals come from /technicals/rankings (TTL),
  // not one-sided tech_score_snapshots and not a 750KB /technicals/all pull.
  const { data: allTechnicalsData, isLoading: technicalsLoading } = useQuery({
    queryKey: queryKeys.technicalsAllSlim,
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all?slim=1", { credentials: "include" });
      if (!res.ok) throw new Error("technicals/all slim fetch failed");
      return res.json();
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const { data: techRankingsData, isLoading: techRankingsLoading } = useQuery({
    queryKey: queryKeys.technicalsRankings(isCallMode ? "call" : "put"),
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const side = isCallMode ? "call" : "put";
      const res = await fetch(`/api/technicals/rankings?side=${side}`, { credentials: "include" });
      if (!res.ok) throw new Error("technicals/rankings fetch failed");
      return res.json();
    },
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  // Overall ticker set fallback (if rankings snapshot empty) — premium-IV candidates.
  const overallTickers = useMemo(() => {
    if (universe !== "overall" || !allTechnicalsData?.length) return [] as string[];
    return selectPremiumCandidates(
      allTechnicalsData.map((r) => ({
        ticker: r.ticker,
        atmPutIv: r.atmPutIv,
        ivVsRealizedVol: r.ivVsRealizedVol,
        technicalsCoverage: r.technicalsCoverage,
      })),
      200,
    );
  }, [universe, allTechnicalsData]);

  // Nightly DB snapshots — both Overall and Watchlist seed scores from these
  // (watchlist = rankings ∩ watchlist). Chains load only on row expand.
  const rankingSide = isCallMode ? "call" : "put";
  const { data: optionRankings, isLoading: optionRankingsLoading } = useQuery({
    queryKey: queryKeys.optionsRankings(rankingSide),
    queryFn: async (): Promise<{
      rankings: Array<{
        ticker: string;
        optionScore: number;
        weeklyIncomePct: number | null;
        otmPct: number | null;
        delta: number | null;
        strikeIv: number | null;
        atmPutIv: number | null;
        dte: number | null;
        spot: number;
        strike: number;
        expiry: string;
        premium: number;
        bidIsLive: boolean;
      }>;
      asOf: string | null;
      computedAt: string | null;
    }> => {
      const res = await fetch(`/api/options/rankings?side=${rankingSide}`);
      if (!res.ok) throw new Error("options rankings fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const rankingByTicker = useMemo(() => {
    const m = new Map<string, NonNullable<typeof optionRankings>["rankings"][number]>();
    for (const r of optionRankings?.rankings ?? []) m.set(r.ticker, r);
    return m;
  }, [optionRankings]);

  const activeTickers = useMemo(() => {
    if (universe === "overall") {
      const fromSnap = (optionRankings?.rankings ?? [])
        .map((r) => r.ticker)
        .filter((t) => !hiddenTickers.has(t));
      if (fromSnap.length > 0) return fromSnap;
      return overallTickers.filter((t) => !hiddenTickers.has(t));
    }
    // Full watchlist (minus red/hidden). Missing nightly scores show N/A + reason; gap-fill tries live calc.
    return entries.filter(e => e.colorTag !== RED_TAG && !hiddenTickers.has(e.ticker)).map(e => e.ticker);
  }, [universe, optionRankings, overallTickers, entries, hiddenTickers]);

  const colorMap = useMemo(
    () => new Map(entries.map(e => [e.ticker, e.colorTag])),
    [entries],
  );

  const displayTickers = activeTickers;
  const isLoaded = universe === "overall"
    ? (!optionRankingsLoading && (optionRankings != null || (!technicalsLoading && !!allTechnicalsData && !techRankingsLoading)))
    : watchlistLoaded;

  // ── Options chains ─────────────────────────────────────────────────────────
  // No batch on load — scores from rankings snapshots; chains load on expand.
  const displayTickersKey = useMemo(() => [...displayTickers].sort().join(","), [displayTickers]);

  // ── Scorecard — watchlist only. Overall uses technicals rows (no N-ticker recompute).
  const { data: scorecardData, isLoading: scorecardLoading, refetch: refetchScorecard } = useQuery({
    queryKey:             ["technical-scorecard", displayTickersKey],
    queryFn:              async () => {
      const q = displayTickersKey
        ? `?tickers=${encodeURIComponent(displayTickersKey)}`
        : "";
      const res = await fetch(`/api/technical/scorecard${q}`);
      if (!res.ok) throw new Error("scorecard fetch failed");
      return res.json() as Promise<ScorecardRow[]>;
    },
    enabled:              universe === "watchlist" && isLoaded && displayTickers.length > 0,
    staleTime:            10 * 60_000,
    refetchOnWindowFocus: false,
  });

  // Subscribe to shared batch cache (filled by expand / Live fallback) — never auto-fetch.
  const { data: batchOptionsData } = useQuery({
    queryKey: queryKeys.optionsBatch(displayTickersKey),
    queryFn: async () => ({} as Record<string, OptionsChainResult[] | { error: string }>),
    enabled: false,
    staleTime: 5 * 60_000,
  });

  // WRDS IBES street-event flags (local cache) — tighter ER haircut for puts and calls.
  const { data: wrdsSignals } = useQuery({
    queryKey: ["research-wrds-signals", displayTickersKey],
    queryFn: async () => {
      const res = await fetch(
        `/api/research/wrds/signals?tickers=${encodeURIComponent(displayTickersKey)}`,
        { credentials: "include" },
      );
      if (!res.ok) return { signals: {} as Record<string, { streetEventRisk: boolean }> };
      return res.json() as Promise<{ signals: Record<string, { streetEventRisk: boolean }> }>;
    },
    enabled: isLoaded && displayTickers.length > 0,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const streetRiskMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const [t, s] of Object.entries(wrdsSignals?.signals ?? {})) {
      if (s?.streetEventRisk) m.set(t, true);
    }
    return m;
  }, [wrdsSignals]);

  // ── Derived maps ─────────────────────────────────────────────────────────────
  const scorecardFromApi = useMemo(
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
      const entry = batchOptionsData?.[t];
      const hasData = refreshedOptions.has(t) || (entry != null && !("error" in entry));
      const failed = chainFailed.has(t);
      m.set(t, expandedSet.has(t) && !hasData && !failed);
    });
    return m;
  }, [displayTickers, batchOptionsData, refreshedOptions, expandedSet, chainFailed]);

  // ── Today's oversold/overbought hotlist membership (Live tab) — surfaced as a
  // badge in this table so a ticker flagged there isn't missed here too.
  const { data: liveHotlists } = useQuery({
    queryKey: ["live-state"],
    queryFn: async (): Promise<{ hotlist: { ticker: string }[]; rallyHotlist: { ticker: string }[] }> => {
      const res = await fetch("/api/live/state", { credentials: "include" });
      if (!res.ok) throw new Error("live/state fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const oversoldSet = useMemo(
    () => new Set((liveHotlists?.hotlist ?? []).map(e => e.ticker)),
    [liveHotlists],
  );
  const overboughtSet = useMemo(
    () => new Set((liveHotlists?.rallyHotlist ?? []).map(e => e.ticker)),
    [liveHotlists],
  );
  const { data: modelList } = useModelList();
  const modelAvoidSet = useMemo(() => new Set(modelAvoidTickers(modelList)), [modelList]);

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
    queryKey: [...queryKeys.fundamentalsRankings, "slim"],
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const res = await fetch("/api/fundamentals/rankings?slim=1");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json();
    },
    refetchOnWindowFocus: false,
    staleTime: 10 * 60_000,
  });

  // Side-aware V2 totals from API (put vs call). Full TechnicalScore shape is not
  // needed on the board — only totalScore for stock/option blend.
  const rankings = useMemo(() => {
    if (!techRankingsData?.length) return new Map<string, TechnicalScore>();
    return new Map(
      techRankingsData.map((s) => [
        s.ticker,
        { ticker: s.ticker, totalScore: s.totalScore } as TechnicalScore,
      ]),
    );
  }, [techRankingsData]);

  // Tech row map (full fields for Option Scorer — includes swingLow, pivotS1, atr14, etc.)
  const techRowMap = useMemo(
    () => new Map((allTechnicalsData ?? []).map(r => [r.ticker, r])),
    [allTechnicalsData],
  );

  // Overall: RSI/IV/price from technicals + snapshot spot — no scorecard fan-out.
  const scorecardMap = useMemo(() => {
    const m = new Map(scorecardFromApi);
    if (universe !== "overall") return m;
    for (const ticker of displayTickers) {
      if (m.has(ticker)) continue;
      const tech = techRowMap.get(ticker);
      if (!tech) continue;
      const rsi = pfNum(tech.rsi14) ?? 0;
      const iv = pfNum(tech.atmPutIv) ?? 0;
      const snap = rankingByTicker.get(ticker);
      m.set(ticker, {
        ticker,
        scoredDate: "",
        rsi,
        mfi: 0,
        rsiThreshold: 40,
        mfiThreshold: 25,
        rsiOk: rsi < 40,
        mfiOk: false,
        signal: rsi < 30 ? "GO" : rsi < 40 ? "WATCH" : "NO",
        tier: 2,
        atr: pfNum(tech.atr14),
        macdCross: null,
        stoch: pfNum(tech.stoch),
        return5d: null,
        position52w: null,
        vsSpy20d: null,
        earningsDate: null,
        rsiYesterday: pfNum(tech.rsi14) ?? 0,
        price: snap?.spot ?? 0,
        ivCurrent: iv,
        ivPercentile: pfNum(tech.ivPercentile) ?? 50,
        ma200: pfNum(tech.ma200),
        stale: false,
      } as ScorecardRow);
    }
    return m;
  }, [scorecardFromApi, universe, displayTickers, techRowMap, rankingByTicker]);

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

  // Collapsed-row Option Score / Income / Buffer: nightly snapshot wins when present.
  // Live chains only fill names with no snap (and feed the expanded strike panel) —
  // expanding must not rewrite board numbers.
  const { bestOptionScoreMap, bestIncomeMap, bufferMap } = useMemo(() => {
    const scoreMap = new Map<string, number>();
    const incomeMap = new Map<string, number>();
    const bufMap = new Map<string, number>();
    for (const ticker of displayTickers) {
      const snap = rankingByTicker.get(ticker);
      if (snap) {
        scoreMap.set(ticker, snap.optionScore);
        if (snap.weeklyIncomePct != null) incomeMap.set(ticker, snap.weeklyIncomePct);
        // Snapshot otmPct is a fraction (0.08 = 8%), same as live pickBestStrike — not "percent points".
        // Prefer strike IV; fall back to ATM put IV so Buf isn't blank when strike IV missing.
        const otm = snap.otmPct ?? 0;
        const ivRaw = snap.strikeIv ?? snap.atmPutIv ?? 0;
        const iv = ivRaw > 2 ? ivRaw / 100 : ivRaw; // tolerate percent-point storage
        const dte = snap.dte ?? 0;
        if (otm > 0 && iv > 0 && dte > 0) {
          bufMap.set(ticker, otm / (iv * Math.sqrt(dte / 365)));
        }
        continue;
      }
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
        earningsDaysOut:       techRow.earningsDaysOut ?? null,
        streetEventRisk:       streetRiskMap.get(ticker) ?? false,
      };
      const picked = pickBestStrike(
        chains.map(c => ({ ...c, options: isCallMode ? c.calls : c.puts })),
        stockCtx, macroRegimeData?.regime ?? "BASELINE", allWatchlistIVs, undefined,
        effectiveStrikeWeights, isCallMode, pickOpts,
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
  }, [displayTickers, optionsMap, techRowMap, rankings, fundScoreMap, macroRegimeData, allWatchlistIVs, effectiveStrikeWeights, isCallMode, pickOpts, rankingByTicker, streetRiskMap]);

  /** Why Opt/Inc/Buf show N/A — hover explains; never hide the row. */
  const scoreNAReasonMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const ticker of displayTickers) {
      const hasOpt = bestOptionScoreMap.has(ticker);
      const hasInc = bestIncomeMap.has(ticker);
      const hasBuf = bufferMap.has(ticker);
      if (hasOpt && hasInc && hasBuf) continue;

      if (chainFailed.has(ticker)) {
        m.set(ticker, chainFailed.get(ticker)!);
        continue;
      }

      const snap = rankingByTicker.get(ticker);
      if (!snap) {
        const chains = optionsMap.get(ticker);
        if (optionsLoadingMap.get(ticker)) {
          m.set(ticker, "Loading live options chain to score…");
        } else if (chains == null) {
          m.set(ticker, "No nightly option score — will try live chain (expand or wait for gap-fill). Often thin/illiquid options.");
        } else if (chains.length === 0) {
          m.set(ticker, "Live chain empty — no strikes in the 1–28 DTE window.");
        } else {
          m.set(ticker, "Chain loaded but no viable live-bid strike met income/OTM gates.");
        }
        continue;
      }

      if (!hasOpt) m.set(ticker, "Nightly snapshot missing option score.");
      else if (!hasInc) m.set(ticker, "No weekly income on snapshot (Inc N/A).");
      else if (!hasBuf) m.set(ticker, "Buffer N/A — need OTM%, strike/ATM IV, and DTE on the snapshot strike.");
    }
    return m;
  }, [displayTickers, bestOptionScoreMap, bestIncomeMap, bufferMap, rankingByTicker, optionsMap, chainFailed, optionsLoadingMap]);

  // Stock Score for collapsed columns — snap/scorecard spot (stable sort). Live price
  // is display-only via /live/prices; do not feed it here or the board reshuffles.
  const stockScoreMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const ticker of displayTickers) {
      const techRow   = techRowMap.get(ticker);
      const indicator = scorecardMap.get(ticker);
      const boardSpot = (indicator?.price != null && indicator.price > 0)
        ? indicator.price
        : (rankingByTicker.get(ticker)?.spot ?? null);
      const relMove   = computeRelativeMove(
        pfNum(techRow?.priceZScore),
        pfNum(techRow?.priceVsMa50Atr),
        indicator?.return5d ?? null,
        pfNum(techRow?.swingHigh20d),
        pfNum(techRow?.swingLow20d),
        boardSpot,
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
  }, [displayTickers, techRowMap, scorecardMap, rankingByTicker, rankings, fundScoreMap, bestOptionScoreMap, colorMap, weights.optionStock, isCallMode]);

  // ── Sort + filter ─────────────────────────────────────────────────────────────
  // Board order must NOT change when a row is expanded (live chain fetch updates
  // optionsMap → bestOptionScoreMap for display only). Sort keys prefer nightly
  // snapshots / scorecard / fund+tech — never live pickBestStrike overrides.
  const sortedTickers = useMemo(() => {
    const scorecard = scorecardMap;
    const idx = new Map(displayTickers.map((t, i) => [t, i]));
    const stable = (a: string, b: string) => (idx.get(a) ?? 0) - (idx.get(b) ?? 0);

    const snapOption = (t: string) => rankingByTicker.get(t)?.optionScore ?? null;
    const snapIncome = (t: string) => rankingByTicker.get(t)?.weeklyIncomePct ?? null;
    const snapBuffer = (t: string) => {
      const snap = rankingByTicker.get(t);
      if (!snap) return null;
      const otm = snap.otmPct ?? 0; // fraction, not percent points
      const ivRaw = snap.strikeIv ?? snap.atmPutIv ?? 0;
      const iv = ivRaw > 2 ? ivRaw / 100 : ivRaw;
      const dte = snap.dte ?? 0;
      if (!(otm > 0 && iv > 0 && dte > 0)) return null;
      return otm / (iv * Math.sqrt(dte / 365));
    };
    const snapOtm = (t: string) => rankingByTicker.get(t)?.otmPct ?? null;

    /** Stock score for sorting — option leg from snapshot only so expand can't reshuffle. */
    const sortStockScore = (t: string) => {
      const techRow = techRowMap.get(t);
      const indicator = scorecard.get(t);
      const relMove = computeRelativeMove(
        pfNum(techRow?.priceZScore),
        pfNum(techRow?.priceVsMa50Atr),
        indicator?.return5d ?? null,
        pfNum(techRow?.swingHigh20d),
        pfNum(techRow?.swingLow20d),
        null, // no live spot — expand must not move rows
        isCallMode ? "call" : "put",
      );
      return computeStockScore({
        techTotalScore: rankings.get(t)?.totalScore ?? null,
        fundTotalScore: fundScoreMap.get(t) ?? null,
        relativeMoveScore: relMove,
        bestOptionScore: snapOption(t),
        colorTag: colorMap.get(t) ?? null,
      }, weights.optionStock).stockScore;
    };

    const list = [...displayTickers];
    list.sort((a, b) => {
      let cmp = 0;
      switch (sort) {
        case "optionScore": {
          const sa = snapOption(a);
          const sb = snapOption(b);
          if (sa != null && sb != null) cmp = sb - sa;
          else if (sa != null) cmp = -1;
          else if (sb != null) cmp = 1;
          break;
        }
        case "score":
          cmp = sortStockScore(b) - sortStockScore(a);
          break;
        case "iv": {
          const iv = (t: string) => scorecard.get(t)?.ivCurrent ?? -1;
          cmp = iv(b) - iv(a);
          break;
        }
        case "buffer": {
          const ba = snapBuffer(a);
          const bb = snapBuffer(b);
          if (ba != null && bb != null) cmp = bb - ba;
          else if (ba != null) cmp = -1;
          else if (bb != null) cmp = 1;
          break;
        }
        case "otm": {
          const oa = snapOtm(a);
          const ob = snapOtm(b);
          if (oa != null && ob != null) cmp = ob - oa;
          else if (oa != null) cmp = -1;
          else if (ob != null) cmp = 1;
          break;
        }
        case "income":
        default: {
          const ia = snapIncome(a);
          const ib = snapIncome(b);
          if (ia != null && ib != null) cmp = ib - ia;
          else if (ia != null) cmp = -1;
          else if (ib != null) cmp = 1;
          break;
        }
      }
      return cmp !== 0 ? cmp : stable(a, b);
    });
    return list;
  }, [
    displayTickers, sort, rankingByTicker, scorecardMap, techRowMap, rankings,
    fundScoreMap, colorMap, weights.optionStock, isCallMode,
  ]);

  const filteredTickers = useMemo(() => {
    const q = tickerQuery.trim().toLowerCase();
    return q ? sortedTickers.filter(t => t.toLowerCase().includes(q)) : sortedTickers;
  }, [sortedTickers, tickerQuery]);

  // Overall DOM cap — full ranked list can be 100–200 rows; show top 75 unless filtering.
  const OVERALL_VISIBLE = 75;
  const visibleTickers = useMemo(() => {
    if (universe === "overall" && !tickerQuery.trim()) {
      return filteredTickers.slice(0, OVERALL_VISIBLE);
    }
    return filteredTickers;
  }, [universe, tickerQuery, filteredTickers]);

  // Golden-source live equity prices (Schwab→Yahoo, 60s server TTL). Overlay only —
  // sort/option scores stay on nightly snapshots so the board does not reshuffle.
  const visibleTickersKey = visibleTickers.join(",");
  const { data: moverFacts } = useMoverFacts(visibleTickers, 5);
  const { data: livePrices } = useQuery({
    queryKey: ["live-prices", visibleTickersKey],
    queryFn: async (): Promise<Record<string, { price: number | null; changePercent: number | null }>> => {
      const res = await fetch(`/api/live/prices?tickers=${encodeURIComponent(visibleTickersKey)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("live/prices failed");
      const body = await res.json() as { prices: Record<string, { price: number | null; changePercent: number | null }> };
      return body.prices ?? {};
    },
    enabled: visibleTickers.length > 0,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  // Continuous heat scales for Opt/Stock/IV/Inc/Buf across the visible board.
  const columnHeat = useMemo(() => {
    const ivOf = (t: string) => {
      const iv = scorecardMap.get(t)?.ivCurrent;
      return iv != null && iv > 0 ? (iv <= 1.5 ? Math.round(iv * 100) : Math.round(iv)) : null;
    };
    return {
      opt: colRange(visibleTickers.map((t) => bestOptionScoreMap.get(t) ?? null)),
      stock: colRange(visibleTickers.map((t) => stockScoreMap.get(t) ?? null)),
      iv: colRange(visibleTickers.map(ivOf)),
      inc: colRange(visibleTickers.map((t) => bestIncomeMap.get(t) ?? null)),
      buf: colRange(visibleTickers.map((t) => bufferMap.get(t) ?? null)),
    };
  }, [visibleTickers, bestOptionScoreMap, stockScoreMap, scorecardMap, bestIncomeMap, bufferMap]);

  // ── Handlers ──────────────────────────────────────────────────────────────────
  const CHAIN_FETCH_MS = 12_000;

  /** Priority single-ticker chain fetch (expand / admin refresh). Hard timeout — thin names must not spin forever. */
  const ensureTickerChain = useCallback(async (ticker: string) => {
    setChainFailed((prev) => {
      if (!prev.has(ticker)) return prev;
      const next = new Map(prev);
      next.delete(ticker);
      return next;
    });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CHAIN_FETCH_MS);
    try {
      const res = await fetch(`/api/options/${ticker}`, { signal: ac.signal });
      if (!res.ok) throw new Error(`options fetch failed: ${ticker}`);
      const data = await res.json() as OptionsChainResult[];
      setRefreshedOptions(prev => new Map(prev).set(ticker, data));
      queryClient.setQueryData(
        queryKeys.optionsBatch(displayTickersKey),
        (old: Record<string, OptionsChainResult[] | { error: string }> | undefined) =>
          old ? { ...old, [ticker]: data } : { [ticker]: data },
      );
    } catch (err) {
      const msg = err instanceof Error && err.name === "AbortError"
        ? "Options chain timed out (thin/illiquid name?)"
        : "No usable options chain";
      setChainFailed((prev) => new Map(prev).set(ticker, msg));
      queryClient.setQueryData(
        queryKeys.optionsBatch(displayTickersKey),
        (old: Record<string, OptionsChainResult[] | { error: string }> | undefined) =>
          old ? { ...old, [ticker]: { error: msg } } : { [ticker]: { error: msg } },
      );
    } finally {
      clearTimeout(timer);
    }
  }, [queryClient, displayTickersKey]);

  const hasCachedChain = useCallback((ticker: string) => (
    refreshedOptions.has(ticker)
    || (batchOptionsData?.[ticker] != null && !("error" in (batchOptionsData[ticker] as object)))
  ), [refreshedOptions, batchOptionsData]);

  /** Prefetch on hover — skip names that already failed (timeouts); others get a chance to score. */
  const handleRowPrefetch = useCallback((ticker: string) => {
    if (chainFailed.has(ticker)) return;
    if (!hasCachedChain(ticker)) void ensureTickerChain(ticker);
  }, [hasCachedChain, ensureTickerChain, chainFailed]);

  const handleExpand = (ticker: string) => {
    setExpandedSet(prev => {
      const next = new Set(prev);
      const opening = !next.has(ticker);
      if (opening) next.add(ticker);
      else next.delete(ticker);
      // Retry after a prior fail/timeout when the user expands again.
      if (opening && (!hasCachedChain(ticker) || chainFailed.has(ticker))) void ensureTickerChain(ticker);
      return next;
    });
  };

  // sessionStorage can restore expanded rows without a fetch — remount must load or clear spinner.
  useEffect(() => {
    for (const t of expandedSet) {
      if (!hasCachedChain(t) && !chainFailed.has(t)) void ensureTickerChain(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when expanded set identity changes
  }, [expandedSet]);

  // Gap-fill: watchlist names with no nightly snapshot — fetch chains (concurrency 2) so Opt/Inc/Buf
  // can calculate live. Failures become N/A + reason, not hidden rows.
  useEffect(() => {
    if (universe !== "watchlist" || !isLoaded || optionRankingsLoading) return;
    const need = displayTickers.filter(
      (t) => !rankingByTicker.has(t) && !hasCachedChain(t) && !chainFailed.has(t),
    );
    if (need.length === 0) return;
    let cancelled = false;
    let cursor = 0;
    const CONCURRENCY = 2;
    async function worker() {
      while (!cancelled && cursor < need.length) {
        const t = need[cursor++]!;
        await ensureTickerChain(t);
      }
    }
    void Promise.all(Array.from({ length: Math.min(CONCURRENCY, need.length) }, () => worker()));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [universe, isLoaded, optionRankingsLoading, displayTickersKey, optionRankings?.asOf]);

  const handleRowRefresh = async (ticker: string) => {
    setChainFailed((prev) => {
      if (!prev.has(ticker)) return prev;
      const next = new Map(prev);
      next.delete(ticker);
      return next;
    });
    setRefreshedOptions((prev) => {
      if (!prev.has(ticker)) return prev;
      const next = new Map(prev);
      next.delete(ticker);
      return next;
    });
    await ensureTickerChain(ticker);
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

  // Win-rate + min-income + ticker filter → Settings popover (compact rankings chrome).
  const filterSettingsPanel = (
    <div className="space-y-3">
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Track record</p>
        <CredibilityBadge side={isCallMode ? "call" : "put"} className="text-[10px] px-1.5 py-0" />
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
          <TrendingUp className="w-3 h-3 text-emerald-400" />
          Min %/wk
        </label>
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
          title="Hide strikes below this weekly return % of strike"
          className="h-7 w-full px-2 text-xs rounded-md border border-white/20 bg-zinc-900 text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50"
        />
      </div>
      <div>
        <label className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5 block">Ticker filter</label>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={tickerQuery}
            onChange={e => setTickerQuery(e.target.value)}
            placeholder="Filter ticker..."
            className="h-7 w-full pl-7 pr-2 text-xs rounded-md border border-white/20 bg-white text-black placeholder:text-gray-500 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>
      <p className="text-[10px] text-amber-200/40 leading-snug">
        Unvalidated ranking · Model List decides. Blends income/buffer with v4 technical total (lab: no edge).
        Names without a nightly score show N/A until a live chain scores them (or stay N/A if the chain is thin).
      </p>
    </div>
  );

  // Sell Puts / Sell Calls — match Technical tab chrome (zinc/gold).
  // Hidden when parent controls side (rankings chrome owns the toggle for stable layout).
  const scanModeToggle = sideControlled ? null : (
    <div className="flex items-center rounded-full border border-[#d4af37]/25 bg-zinc-950 p-0.5 text-[11px] h-6 shrink-0">
      <button
        onClick={() => setMode("puts")}
        className={cn(
          "px-2 h-5 rounded-full transition-colors font-semibold",
          !isCallMode ? "bg-[#d4af37]/25 text-[#d4af37]" : "text-amber-200/50 hover:text-[#d4af37]",
        )}
      >
        Sell Puts
      </button>
      <button
        onClick={() => setMode("calls")}
        className={cn(
          "px-2 h-5 rounded-full transition-colors font-semibold",
          isCallMode ? "bg-[#d4af37]/25 text-[#d4af37]" : "text-amber-200/50 hover:text-[#d4af37]",
        )}
      >
        Sell Calls
      </button>
    </div>
  );

  const filterSettingsButton = (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 h-6 px-2 rounded-full border border-[#d4af37]/25 bg-zinc-950 text-[11px] font-semibold text-amber-200/70 hover:text-[#d4af37] hover:border-[#d4af37]/40 transition-colors"
          title="Filters — min income, ticker, track record"
        >
          <Settings2 className="w-3 h-3" />
          Filters
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3 bg-zinc-950 border-[#d4af37]/25">
        {filterSettingsPanel}
      </PopoverContent>
    </Popover>
  );

  const controlsRow = (
    <div className="flex items-center gap-1">
      {scanModeToggle}
      {filterSettingsButton}
    </div>
  );

  const countLabel =
    universe === "overall"
      ? `${visibleTickers.length}/${filteredTickers.length}`
      : String(visibleTickers.length);
  const snapDate = optionRankings?.asOf ? formatMdYy(optionRankings.asOf) : null;

  return (
    <div className="space-y-2 min-w-0">
        {showHeader && <h1 className="text-xl font-bold">Options Scanner</h1>}

        {/* Controls — hidden here and portaled into the tab bar when filterSlot is present */}
        {!filterSlot && (
          <div className="flex items-center gap-2 flex-wrap">
            {controlsRow}
          </div>
        )}
        {filterSlot && createPortal(controlsRow, filterSlot)}

        {/* Scanner table — same zinc/gold card chrome as fund/tech leaderboards */}
        {((universe === "watchlist" && scorecardLoading) || !isLoaded) ? (
          <div className="flex items-center gap-2 text-sm text-white py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            {universe === "overall" ? "Loading Overall rankings…" : "Loading scorecard…"}
          </div>
        ) : filteredTickers.length === 0 ? (
          <div className="text-sm text-white py-8 text-center space-y-1">
            <div>No tickers match current filters.</div>
            {universe === "overall" && (
              <div className="text-xs text-amber-200/50">
                Overall uses nightly option-score snapshots (or premium-IV candidates). Snapshots: {optionRankings?.rankings?.length ?? 0}; candidates: {overallTickers.length}.
              </div>
            )}
          </div>
        ) : (
          <div className="bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-2 shadow-lg shadow-black/60 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <Trophy className="w-3.5 h-3.5 text-primary shrink-0" />
                <h2 className="text-xs font-bold tracking-tight">Options Leaderboard</h2>
                <span className="text-[11px] text-muted-foreground tabular-nums">{countLabel}</span>
                {snapDate && (
                  <span className="text-[9px] text-muted-foreground/70" title="Snapshot as-of date">
                    {snapDate}
                  </span>
                )}
              </div>
              {isAdmin && (
                <button
                  className="flex items-center gap-1 text-[11px] text-amber-200/70 hover:text-[#d4af37] transition-colors shrink-0"
                  onClick={handleGlobalRefresh}
                  disabled={scorecardLoading}
                >
                  {scorecardLoading
                    ? <Loader2 className="w-3 h-3 animate-spin" />
                    : <RefreshCw className="w-3 h-3" />
                  }
                  {minutesAgo(refreshedAt)}
                </button>
              )}
            </div>

            <div className="rounded-md border border-[#d4af37]/25 overflow-x-auto bg-black/40">
            {/* Column headers — track matches ScannerRow; only #/Ticker/Price stay bold */}
            <div
              className={cn(OPTIONS_BOARD_COLS, "px-1.5 py-1 border-b border-[#d4af37]/25 bg-black text-[10px] tracking-wide uppercase text-[#d4af37]")}
              style={{ borderLeft: "3px solid transparent" }}
            >
              <div className="text-center font-semibold">#</div>
              <div className="font-semibold">Ticker</div>
              <div className="font-semibold" title="Live equity quote (Schwab→Yahoo cache); % under price = vs nightly options snapshot">Price</div>
              <div className="font-normal text-amber-200/55">Sig</div>
              <div className="font-normal text-amber-200/55" title="Graded sell-put/sell-call win-loss (Sharpe / StkΔ in row tooltip)">Rec</div>
              <div className="font-normal text-amber-200/55" title="Hover a row's RSI value for full reasoning">RSI</div>
              <SortableHeader label="Opt" sortKey="optionScore" active={sort === "optionScore"} onClick={setSort} />
              <SortableHeader label="Stock" sortKey="score" active={sort === "score"} onClick={setSort} />
              <SortableHeader label="IV" sortKey="iv" active={sort === "iv"} onClick={setSort} />
              <SortableHeader label="Inc" sortKey="income" active={sort === "income"} onClick={setSort} />
              <SortableHeader label="Buf" sortKey="buffer" active={sort === "buffer"} onClick={setSort} />
              <div aria-hidden className="w-full" />
            </div>
            {visibleTickers.map((ticker, i) => (
              <ScannerRow
                key={ticker}
                ticker={ticker}
                rank={i + 1}
                rowIndex={i}
                colorTag={colorMap.get(ticker) ?? ""}
                indicator={scorecardMap.get(ticker) ?? null}
                score={rankings.get(ticker) ?? null}
                optionsData={optionsMap.get(ticker) ?? null}
                optionsLoading={optionsLoadingMap.get(ticker) ?? false}
                chainError={chainFailed.get(ticker) ?? null}
                expanded={expandedSet.has(ticker)}
                minIncome={minIncome}
                overrideEnabled={overrides.has(ticker)}
                onExpand={() => handleExpand(ticker)}
                onPrefetch={() => handleRowPrefetch(ticker)}
                onRefresh={isAdmin ? () => handleRowRefresh(ticker) : undefined}
                onDelete={() => handleDelete(ticker)}
                onOverride={() => handleOverride(ticker)}
                techRow={techRowMap.get(ticker) ?? null}
                fundTotalScore={fundScoreMap.get(ticker) ?? null}
                streetEventRisk={streetRiskMap.get(ticker) ?? false}
                macroRegime={macroRegimeData?.regime ?? "BASELINE"}
                allWatchlistIVs={allWatchlistIVs}
                strikeWeights={effectiveStrikeWeights}
                bestOptionScore={bestOptionScoreMap.get(ticker) ?? null}
                bestIncome={bestIncomeMap.get(ticker) ?? null}
                bestBuffer={bufferMap.get(ticker) ?? null}
                scoreNAReason={scoreNAReasonMap.get(ticker) ?? null}
                stockScore={stockScoreMap.get(ticker) ?? null}
                isCall={isCallMode}
                isOversold={oversoldSet.has(ticker)}
                isOverbought={overboughtSet.has(ticker)}
                modelAvoid={modelAvoidSet.has(ticker.toUpperCase())}
                moverFactLine={moverFacts?.[ticker.toUpperCase()]?.line ?? null}
                livePrice={livePrices?.[ticker]?.price ?? null}
                snapSpot={rankingByTicker.get(ticker)?.spot ?? null}
                heat={columnHeat}
              />
            ))}
            </div>
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
