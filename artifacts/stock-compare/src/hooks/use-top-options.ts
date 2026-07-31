// Top-N ranked sell-put / sell-call candidates for the Live tab — the pure ranking
// path extracted from options-scanner.tsx (page state like sort/refresh/expansion
// stays behind). Query keys and the ticker set are byte-for-byte identical to the
// scanner's so react-query serves both pages from ONE shared cache: visiting either
// page warms the other, and the heavy /api/options/batch call fires at most once
// per 5-minute staleTime window.
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWatchlist } from "@/hooks/use-watchlist";
import { useAuth } from "@/context/AuthContext";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { useTrackRecordTilt } from "@/hooks/use-track-record-tilt";
import { queryKeys } from "@/lib/query-keys";
import { computeTechnicalRankingsV2, type TechnicalRow } from "@/lib/technical-rankings";
import { pickBestStrike, type StockContext } from "@/lib/option-scorer";
import { type MacroRegime, CALL_STRIKE_WEIGHTS } from "@/lib/option-scorer-constants";

// Chain/row shapes match the /api/options/batch payload (declared locally in
// options-scanner.tsx too — structural types, kept in sync with the server).
interface OptionRow {
  strike: number;
  bid: number;
  ask: number;
  lastPrice: number;
  iv: number;
  volume: number | null;
  openInterest: number | null;
  incomePct: number;
  meetsGate: boolean;
  bidIsLive: boolean;
  delta: number | null;
  spreadPct: number | null;
}

interface OptionsChainResult {
  ticker: string;
  expiry: string;
  isWeekly: boolean;
  daysToExpiry: number;
  exactDte: number;
  settlementDte: number;
  spot: number;
  tier: 1 | 2 | 3;
  puts: OptionRow[];
  calls: OptionRow[];
  fetchedAt: number;
}

interface MacroRegimeResult {
  regime: MacroRegime;
}

const RED_TAG = "#ef4444"; // mirrors options-scanner.tsx — red-tagged tickers are excluded from scans

// Mirrors scannerHiddenKey in options-scanner.tsx — must match so the hidden set
// (and therefore displayTickersKey / the options-batch cache key) agrees between pages.
function scannerHiddenKey(userId: number | undefined): string {
  return userId ? `fildi_scanner_hidden_${userId}` : "fildi_scanner_hidden";
}

function pfNum(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

export interface TopOptionRow {
  ticker: string;
  spot: number;
  strike: number;
  expiry: string;
  dte: number;
  weeklyIncomePct: number;
  otmPct: number; // plain percent, e.g. 8.3
  delta: number | null;
  bufferSigmas: number | null;
  optionScore: number;
  bid: number;
  bidIsLive: boolean;
}

export function useTopOptions(side: "put" | "call", n = 7): { rows: TopOptionRow[]; isFetching: boolean } {
  const isCall = side === "call";
  const { user } = useAuth();
  const { weights, hasCustomOptionStrike } = useScoringPreferences();
  const { data: tilt } = useTrackRecordTilt();
  const { entries, isLoaded } = useWatchlist();

  // Model auto-tilt applies only to untouched defaults; an explicit user override always wins.
  const effectiveStrikeWeights = isCall
    ? (tilt?.call.weights ?? CALL_STRIKE_WEIGHTS)
    : (hasCustomOptionStrike ? weights.optionStrike : (tilt?.put.weights ?? weights.optionStrike));

  const displayTickers = useMemo(() => {
    let hidden = new Set<string>();
    try {
      const s = localStorage.getItem(scannerHiddenKey(user?.id));
      if (s) hidden = new Set(JSON.parse(s));
    } catch { /* corrupt localStorage — treat as none hidden */ }
    return entries.filter(e => e.colorTag !== RED_TAG && !hidden.has(e.ticker)).map(e => e.ticker);
  }, [entries, user?.id]);

  const displayTickersKey = useMemo(() => [...displayTickers].sort().join(","), [displayTickers]);

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

  const { data: batchOptionsData, isFetching } = useQuery({
    queryKey: ["options-batch", displayTickersKey],
    queryFn: async () => {
      const res = await fetch(`/api/options/batch?tickers=${encodeURIComponent(displayTickersKey)}`);
      if (!res.ok) throw new Error("options batch fetch failed");
      return res.json() as Promise<Record<string, OptionsChainResult[] | { error: string }>>;
    },
    enabled: isLoaded && displayTickers.length > 0,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: macroRegimeData } = useQuery({
    queryKey: ["volatility", "regime"],
    queryFn: async (): Promise<MacroRegimeResult> => {
      const res = await fetch("/api/volatility/regime");
      if (!res.ok) return { regime: "BASELINE" };
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: fundRankingsData } = useQuery({
    queryKey: queryKeys.fundamentalsRankings,
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const res = await fetch("/api/fundamentals/rankings");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json();
    },
    refetchOnWindowFocus: false,
  });

  const rows = useMemo((): TopOptionRow[] => {
    if (!allTechnicalsData?.length || !batchOptionsData) return [];

    const rankings = new Map(
      computeTechnicalRankingsV2(allTechnicalsData, {}, weights.technical, side).map(s => [s.ticker, s]),
    );
    const techRowMap = new Map(allTechnicalsData.map(r => [r.ticker, r]));
    const fundScoreMap = new Map((fundRankingsData ?? []).map(r => [r.ticker, r.totalScore]));

    const optionsMap = new Map<string, OptionsChainResult[]>();
    for (const t of displayTickers) {
      const entry = batchOptionsData[t];
      if (entry && !("error" in entry)) optionsMap.set(t, entry);
    }

    const allWatchlistIVs: number[] = [];
    for (const chains of optionsMap.values()) {
      for (const c of chains) for (const p of c.puts) if (p.iv > 0) allWatchlistIVs.push(p.iv);
    }

    const picked: TopOptionRow[] = [];
    for (const [ticker, chains] of optionsMap) {
      const techRow = techRowMap.get(ticker);
      if (!techRow) continue;
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
      const best = pickBestStrike(
        chains.map(c => ({ ...c, options: isCall ? c.calls : c.puts })),
        stockCtx, macroRegimeData?.regime ?? "BASELINE", allWatchlistIVs, undefined,
        effectiveStrikeWeights, isCall,
      );
      if (!best) continue;
      const spot = best.chain.spot ?? 0;
      const exactDte = best.chain.exactDte ?? Math.max(1, best.chain.daysToExpiry);
      const otm = spot > 0
        ? (isCall ? (best.put.strike - spot) / spot : (spot - best.put.strike) / spot)
        : 0;
      picked.push({
        ticker,
        spot,
        strike: best.put.strike,
        expiry: best.chain.expiry,
        dte: best.chain.daysToExpiry,
        weeklyIncomePct: best.result.weeklyIncome,
        otmPct: otm * 100,
        delta: best.put.delta,
        bufferSigmas: spot > 0 && best.put.iv > 0 && exactDte > 0
          ? otm / (best.put.iv * Math.sqrt(exactDte / 365))
          : null,
        optionScore: best.result.optionScore,
        bid: best.put.bid > 0 ? best.put.bid : (best.put as OptionRow).lastPrice,
        bidIsLive: (best.put as OptionRow).bidIsLive, // Opt generic infers the constraint type; the runtime row is a full OptionRow
      });
    }

    // One row per ticker (pickBestStrike already collapses to the best strike) —
    // rank across tickers by option score and keep the top n.
    return picked.sort((a, b) => b.optionScore - a.optionScore).slice(0, n);
  }, [allTechnicalsData, batchOptionsData, fundRankingsData, macroRegimeData, weights, effectiveStrikeWeights, side, isCall, displayTickers, n]);

  return { rows, isFetching };
}
