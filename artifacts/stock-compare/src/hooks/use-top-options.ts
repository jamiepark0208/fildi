// Top-N ranked sell-put / sell-call candidates for the Live tab.
// Fast path: nightly /api/options/rankings filtered to the watchlist (DB, no chain fan-out).
// Fallback: watchlist options-batch + client scoring (shared cache with Rankings → Options).
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useWatchlist } from "@/hooks/use-watchlist";
import { useAuth } from "@/context/AuthContext";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { useTrackRecordTilt } from "@/hooks/use-track-record-tilt";
import { queryKeys } from "@/lib/query-keys";
import { type TechnicalRow } from "@/lib/technical-rankings";
import { pickBestStrike, type StockContext } from "@/lib/option-scorer";
import { type MacroRegime, CALL_STRIKE_WEIGHTS } from "@/lib/option-scorer-constants";

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

interface RankingRow {
  ticker: string;
  strike: number;
  expiry: string;
  spot: number;
  premium: number;
  weeklyIncomePct: number | null;
  otmPct: number | null;
  delta: number | null;
  strikeIv: number | null;
  dte: number | null;
  optionScore: number;
  bidIsLive: boolean;
}

const RED_TAG = "#ef4444";

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
  otmPct: number;
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

  const tiltSide = isCall ? tilt?.call : tilt?.put;
  const effectiveStrikeWeights = isCall
    ? (tilt?.call.weights ?? CALL_STRIKE_WEIGHTS)
    : (hasCustomOptionStrike ? weights.optionStrike : (tilt?.put.weights ?? weights.optionStrike));

  const pickOpts = useMemo(() => ({
    minStockQuality: tiltSide?.sqFloor,
    calibration: tilt?.calibration ?? null,
    earningsHaircut: tiltSide?.earningsHaircut,
  }), [tiltSide?.sqFloor, tiltSide?.earningsHaircut, tilt?.calibration]);

  const displayTickers = useMemo(() => {
    let hidden = new Set<string>();
    try {
      const s = localStorage.getItem(scannerHiddenKey(user?.id));
      if (s) hidden = new Set(JSON.parse(s));
    } catch { /* corrupt localStorage */ }
    return entries.filter(e => e.colorTag !== RED_TAG && !hidden.has(e.ticker)).map(e => e.ticker);
  }, [entries, user?.id]);

  const displayTickersKey = useMemo(() => [...displayTickers].sort().join(","), [displayTickers]);
  const watchlistSet = useMemo(() => new Set(displayTickers), [displayTickers]);

  // Fast path — precomputed Overall snapshots ∩ watchlist (no Schwab/Yahoo fan-out).
  const { data: snapRankings, isFetching: snapFetching } = useQuery({
    queryKey: queryKeys.optionsRankings(side),
    queryFn: async (): Promise<{ rankings: RankingRow[] }> => {
      const res = await fetch(`/api/options/rankings?side=${side}`);
      if (!res.ok) throw new Error("options rankings fetch failed");
      return res.json();
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const fromSnapshots = useMemo((): TopOptionRow[] => {
    const rows = (snapRankings?.rankings ?? [])
      .filter((r) => watchlistSet.has(r.ticker))
      .slice(0, n);
    return rows.map((r) => {
      const otmPct = r.otmPct ?? 0;
      const dte = r.dte ?? 0;
      const iv = r.strikeIv ?? 0;
      const bufferSigmas =
        otmPct > 0 && iv > 0 && dte > 0
          ? (otmPct / 100) / (iv * Math.sqrt(dte / 365))
          : null;
      return {
        ticker: r.ticker,
        spot: r.spot,
        strike: r.strike,
        expiry: r.expiry,
        dte,
        weeklyIncomePct: r.weeklyIncomePct ?? 0,
        otmPct,
        delta: r.delta,
        bufferSigmas,
        optionScore: r.optionScore,
        bid: r.premium,
        bidIsLive: r.bidIsLive,
      };
    });
  }, [snapRankings, watchlistSet, n]);

  const needBatchFallback = isLoaded && displayTickers.length > 0 && fromSnapshots.length < Math.min(3, n);

  const { data: allTechnicalsData } = useQuery({
    queryKey: queryKeys.technicalsAllSlim,
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all?slim=1");
      if (!res.ok) throw new Error("technicals/all slim fetch failed");
      return res.json();
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    enabled: needBatchFallback,
  });

  const { data: techRankingsData } = useQuery({
    queryKey: queryKeys.technicalsRankings(side),
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const res = await fetch(`/api/technicals/rankings?side=${side}`);
      if (!res.ok) throw new Error("technicals/rankings fetch failed");
      return res.json();
    },
    staleTime: 15 * 60 * 1000,
    refetchOnWindowFocus: false,
    enabled: needBatchFallback,
  });

  const { data: batchOptionsData, isFetching: batchFetching } = useQuery({
    queryKey: queryKeys.optionsBatch(displayTickersKey),
    queryFn: async () => {
      const res = await fetch(`/api/options/batch?tickers=${encodeURIComponent(displayTickersKey)}`);
      if (!res.ok) throw new Error("options batch fetch failed");
      return res.json() as Promise<Record<string, OptionsChainResult[] | { error: string }>>;
    },
    enabled: needBatchFallback,
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
    enabled: needBatchFallback,
  });

  const { data: fundRankingsData } = useQuery({
    queryKey: ["fundamentals", "rankings", "slim"],
    queryFn: async (): Promise<Array<{ ticker: string; totalScore: number }>> => {
      const res = await fetch("/api/fundamentals/rankings?slim=1");
      if (!res.ok) throw new Error("fundamentals/rankings failed");
      return res.json();
    },
    refetchOnWindowFocus: false,
    enabled: needBatchFallback,
  });

  const fromBatch = useMemo((): TopOptionRow[] => {
    if (!needBatchFallback || !allTechnicalsData?.length || !techRankingsData?.length || !batchOptionsData) return [];

    const rankings = new Map(techRankingsData.map((s) => [s.ticker, s.totalScore]));
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
        techTotalScore:        rankings.get(ticker) ?? null,
        fundTotalScore:        fundScoreMap.get(ticker) ?? null,
        earningsDaysOut:       techRow.earningsDaysOut ?? null,
      };
      const best = pickBestStrike(
        chains.map(c => ({ ...c, options: isCall ? c.calls : c.puts })),
        stockCtx, macroRegimeData?.regime ?? "BASELINE", allWatchlistIVs, undefined,
        effectiveStrikeWeights, isCall, pickOpts,
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
        bid: best.put.bid,
        bidIsLive: (best.put as OptionRow).bidIsLive,
      });
    }

    return picked.sort((a, b) => b.optionScore - a.optionScore).slice(0, n);
  }, [needBatchFallback, allTechnicalsData, techRankingsData, batchOptionsData, fundRankingsData, macroRegimeData, effectiveStrikeWeights, side, isCall, displayTickers, n, pickOpts]);

  const rows = fromSnapshots.length >= Math.min(3, n) || fromSnapshots.length >= fromBatch.length
    ? fromSnapshots
    : fromBatch;

  return { rows, isFetching: snapFetching || (needBatchFallback && batchFetching) };
}
