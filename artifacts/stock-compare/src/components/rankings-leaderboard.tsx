import { Fragment, memo, useMemo, useState, useEffect } from "react";
import { StockScore } from "@/lib/rankings";
import { StockMetrics } from "@workspace/api-client-react";
import { Trophy, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScoreExplanation } from "@/hooks/useScoreExplanation";
import {
  FUNDAMENTAL_METRIC_BY_KEY, FundamentalFamily, FAMILY_LABEL, FAMILY_ORDER,
  familyWeightsForStyle, formatMetricValue,
  SECTOR_WEIGHT, MIN_SECTOR_PEERS,
} from "@/lib/fundamental-scoring-meta";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow, ROW_CELL, zScoreColor, percentileColor, percentileBadge, highlightBullet, FAMILY_BAR_COLOR } from "@/lib/score-explain-format";
import { formatMdYy } from "@/lib/format";

interface RankingsLeaderboardProps {
  scores: StockScore[];
  stocks?: StockMetrics[];
  /** ISO timestamp when fund scores were last persisted (from API computedAt). */
  scoredAsOf?: string | null;
}

const RANK_STYLE = (idx: number) =>
  idx === 0 ? "bg-yellow-500 text-yellow-950" :
  idx === 1 ? "bg-slate-400 text-slate-950"   :
  idx === 2 ? "bg-amber-700 text-amber-50"    :
              "bg-secondary text-secondary-foreground";

const ROW_STYLE = (idx: number) =>
  idx === 0 ? "border-yellow-500/30 bg-yellow-500/10" :
  idx === 1 ? "border-slate-400/30 bg-slate-400/10"   :
  idx === 2 ? "border-amber-700/30 bg-amber-700/10"   :
              "border-[#d4af37]/10 bg-transparent";

const COL_COUNT = 2 + FAMILY_ORDER.length + 5; // # ticker + 4 fam + score + style + co/sec + breakdown + why

function parseBullets(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s{1,2}(?=[A-Z•\-])/)
    .map(s => s.replace(/^[-•*]\s*/, "").trim())
    .filter(s => s.length > 8);
}

export interface MetricRow {
  key: string;
  label: string;
  valueStr: string;
  weight: number;
  family: FundamentalFamily;
  percentile: number;   // 0-100, this ticker's cross-sectional percentile for the metric
  rankPos: number;      // 1 = best
  n: number;             // peer universe size with non-null data for this metric
  peerMin: string;
  peerMedian: string;
  peerMax: string;
  zScore: number;
  sectorWeight: number;   // 0-1, how much this metric's percentile leans on peerGroup vs market
  // Peer-group-specific comparison — the numbers that actually drove most of `percentile`
  // for high-sectorWeight metrics. Undefined when the ticker has no peer group or the group
  // is too small (< MIN_SECTOR_PEERS) to be meaningful.
  groupN?: number;
  groupMin?: string;
  groupMedian?: string;
  groupMax?: string;
}

function metricLabel(key: string): string {
  const meta = FUNDAMENTAL_METRIC_BY_KEY[key];
  if (meta) return meta.label;
  return key.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim();
}

function percentileOf(rawVal: number, sorted: number[], higherBetter: boolean): number {
  const idx = sorted.findIndex(v => v >= rawVal);
  const rawPct = sorted.length <= 1 ? 0.5 : idx / (sorted.length - 1);
  return higherBetter ? rawPct : 1 - rawPct;
}

// Recomputes the same percentile-rank formula the server uses (computePerMetricScores /
// computeBlendedPctRanks in fundamentals-db.ts) purely from the metric values already present
// in `allScores`, so the breakdown is provably the same number the server used to score this
// ticker — not an approximation. Peer min/median/max/n/z stay whole-universe (real context for
// the reader); only `percentile` blends in the peer-group-relative rank per SECTOR_WEIGHT,
// matching how the metric was actually scored. Grouped by `peerGroupId` (from
// tickerRegistry.primaryPeerGroupId, populated for 273/276 tickers) — NOT tickerRegistry.sector,
// which is only set for a handful of tickers and would silently disable the blend for almost everyone.
function buildMetricRows(score: StockScore, allScores: StockScore[]): MetricRow[] {
  const entries = Object.entries(score.metricScores).filter(([, v]) => v.value != null);
  const scoreGroup = score.peerGroupId ?? null;

  return entries.map(([key, mv]) => {
    const meta = FUNDAMENTAL_METRIC_BY_KEY[key];
    const higherBetter = meta?.higherBetter ?? true;
    const rawVal = mv.value as number;
    const peerVals = allScores
      .map(s => s.metricScores[key]?.value)
      .filter((v): v is number => v != null);
    const sorted = [...peerVals].sort((a, b) => a - b);
    const mean = peerVals.reduce((a, b) => a + b, 0) / peerVals.length;
    const std = Math.sqrt(peerVals.reduce((a, b) => a + (b - mean) ** 2, 0) / peerVals.length);

    const universePct = percentileOf(rawVal, sorted, higherBetter);

    const sectorWeight = SECTOR_WEIGHT[key] ?? 0.5;
    let blendedPct = universePct;
    let groupN: number | undefined;
    let groupMin: string | undefined;
    let groupMedian: string | undefined;
    let groupMax: string | undefined;
    if (scoreGroup) {
      const groupVals = allScores
        .filter(s => s.peerGroupId === scoreGroup)
        .map(s => s.metricScores[key]?.value)
        .filter((v): v is number => v != null);
      if (groupVals.length >= MIN_SECTOR_PEERS) {
        const groupSorted = [...groupVals].sort((a, b) => a - b);
        const groupPct = percentileOf(rawVal, groupSorted, higherBetter);
        blendedPct = groupPct * sectorWeight + universePct * (1 - sectorWeight);
        const gMedian = groupSorted.length % 2 === 1
          ? groupSorted[(groupSorted.length - 1) / 2]
          : (groupSorted[groupSorted.length / 2 - 1] + groupSorted[groupSorted.length / 2]) / 2;
        groupN = groupVals.length;
        groupMin = formatMetricValue(meta, groupSorted[0]);
        groupMedian = formatMetricValue(meta, gMedian);
        groupMax = formatMetricValue(meta, groupSorted[groupSorted.length - 1]);
      }
    }

    // "#N of M" rank, always 1 = best regardless of higher/lower-is-better framing.
    const rankPos = higherBetter === false
      ? sorted.indexOf(rawVal) + 1
      : [...sorted].reverse().indexOf(rawVal) + 1;

    const median = sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

    return {
      key,
      label: metricLabel(key),
      valueStr: formatMetricValue(meta, rawVal),
      weight: meta?.weight ?? 0,
      family: meta?.family ?? "quality",
      percentile: Math.round(blendedPct * 100),
      rankPos,
      n: peerVals.length,
      peerMin: formatMetricValue(meta, sorted[0]),
      peerMedian: formatMetricValue(meta, median),
      peerMax: formatMetricValue(meta, sorted[sorted.length - 1]),
      zScore: std > 0 ? (rawVal - mean) / std : 0,
      sectorWeight,
      groupN, groupMin, groupMedian, groupMax,
    };
  }).sort((a, b) => b.percentile - a.percentile);
}

export interface FamilyBreakdownRow {
  family: FundamentalFamily;
  score: number;
  weight: number;
  contribution: number;
}

// Family bar uses style-bucket weights (same as fund-score-engine). Total score also
// blends ~10% sector opportunity — shown separately as Co / Sec columns.
function buildFamilyBreakdown(score: StockScore): { rows: FamilyBreakdownRow[]; weightSum: number } {
  const weights = familyWeightsForStyle(score.styleBucket);
  const fs = score.familyScores;
  const rows = FAMILY_ORDER.map(fam => {
    const famScore = fs?.[fam]?.score ?? 50;
    const w = weights[fam];
    return { family: fam, score: famScore, weight: w, contribution: (famScore * w) / 100 };
  });
  const weightSum = FAMILY_ORDER.reduce((s, f) => s + weights[f], 0);
  return { rows, weightSum };
}

function buildFundamentalPayload(score: StockScore, allScores: StockScore[], stocks?: StockMetrics[]) {
  const metricRows = buildMetricRows(score, allScores);
  const topRows = [...metricRows].filter(r => r.percentile >= 50).slice(0, 4);
  const weakRows = [...metricRows].filter(r => r.percentile < 50).slice(-4);
  const fs = score.familyScores;
  const stockData = stocks?.find(s => s.ticker === score.ticker);
  return {
    fundamentalData: {
      totalScore: score.totalScore,
      rank: score.rank,
      universeSize: allScores.length,
      familyScores: {
        value:   fs?.value.score   ?? 50,
        growth:  fs?.growth.score  ?? 50,
        quality: fs?.quality.score ?? 50,
        safety:  fs?.safety.score  ?? 50,
      },
      topMetrics:     topRows.map(r => r.label),
      weakMetrics:    weakRows.map(r => r.label),
      reason:         score.reason,
      suspectMetrics: score.suspectMetrics,
      dataQuality:    score.dataQuality,
      sector:         stockData?.sector   ?? undefined,
      industry:       stockData?.industry ?? undefined,
      peerGroup:      score.peerGroupName ?? undefined,
      peerGroupSize:  score.peerGroupSize ?? undefined,
      // Real cross-sectional numbers — instructs the model to cite these instead of guessing.
      // Prefer sector-peer median/range over the whole-market one when available, since that's
      // what actually explains why this ticker beat or lost to a specific rival.
      metricDetails:  Object.fromEntries(metricRows.map(r => [r.label, {
        value: r.valueStr, percentile: r.percentile,
        sectorMedian: r.groupMedian ?? undefined, sectorN: r.groupN ?? undefined,
        marketMedian: r.peerMedian, n: r.n,
      }])),
    },
  };
}

interface ExplainState { text: string; status: "idle" | "loading" | "done" | "error"; }

interface RowProps {
  score: StockScore;
  idx: number;
  rowIdx: number;
  maxScore: number;
  allScores: StockScore[];
  stocks?: StockMetrics[];
  explainState: ExplainState;
  explain: ReturnType<typeof useScoreExplanation>["explain"];
}

function shortenBullet(text: string): string {
  const clean = text.replace(/\*\*/g, "").replace(/^\s*[-•]\s*/, "").trim();
  const sentence = clean.split(/(?<=[.!?])\s/)[0];
  return sentence.length > 160 ? sentence.slice(0, 157) + "…" : sentence;
}

const LeaderboardRow = memo(function LeaderboardRow({ score, idx, rowIdx, maxScore, allScores, stocks, explainState, explain }: RowProps) {
  const state = explainState;
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (state.status === "done" && state.text) setOpen(true);
  }, [state.status, state.text]);

  const isExpanded = state.status === "done" && !!state.text && open;
  const metricRows = isExpanded ? buildMetricRows(score, allScores) : [];
  // Computed unconditionally (not just when expanded) since the collapsed row's stacked bar
  // needs each family's contribution to size its color segments.
  const { rows: familyRows, weightSum } = buildFamilyBreakdown(score);
  const bullets = isExpanded ? parseBullets(state.text).map(shortenBullet).filter(Boolean) : [];

  return (
    <Fragment>
      <tr
        className={cn(idx < 3 ? ROW_STYLE(idx) : gridRow(rowIdx), "align-middle cursor-pointer")}
        onClick={() => {
          if (state.status === "loading") return;
          if (state.status === "done") setOpen(o => !o);
          else explain(score.ticker, "fundamental", buildFundamentalPayload(score, allScores, stocks));
        }}
      >
        <td className={cn(GRID_TD, "text-center")}>
          <span className={cn(
            "inline-flex w-5 h-5 rounded-full items-center justify-center font-bold text-[10px]",
            RANK_STYLE(idx)
          )}>
            {score.rank}
          </span>
        </td>

        <td className={cn(GRID_TD, "whitespace-nowrap")}>
          <span className="font-mono font-bold text-white">{score.ticker}</span>
          <span className="ml-1.5 text-white/40 text-[11px] inline-block max-w-[110px] align-middle truncate">{score.companyName}</span>
        </td>

        {FAMILY_ORDER.map(fam => {
          const r = familyRows.find(fr => fr.family === fam);
          return (
            <td key={fam} className={cn(GRID_TD, "text-right whitespace-nowrap")}>
              {r ? (
                <span className={cn("font-mono font-semibold", percentileColor(r.score))}>{r.score.toFixed(0)}</span>
              ) : (
                <span className="text-white/20">—</span>
              )}
            </td>
          );
        })}

        <td className={cn(GRID_TD, "text-right whitespace-nowrap")}>
          <span className="font-mono font-bold text-white">{score.totalScore.toFixed(1)}</span>
        </td>

        <td
          className={cn(GRID_TD, "text-right whitespace-nowrap text-[10px] text-amber-200/55 font-mono")}
          title={`Style bucket sets family weights${score.confidence ? ` · confidence ${score.confidence}` : ""}`}
        >
          {score.styleBucket ? score.styleBucket.replace(/_/g, " ") : "—"}
        </td>

        <td
          className={cn(GRID_TD, "text-right whitespace-nowrap text-[10px] font-mono text-white/55")}
          title="Company score (pre-blend) · sector opportunity layer. Total ≈ 90% Co + 10% Sec."
        >
          {score.companyScore != null || score.sectorScore != null ? (
            <>
              <span className="text-white/80">{score.companyScore != null ? score.companyScore.toFixed(0) : "—"}</span>
              <span className="text-white/30">/</span>
              <span>{score.sectorScore != null ? score.sectorScore.toFixed(0) : "—"}</span>
            </>
          ) : (
            "—"
          )}
        </td>

        <td className={cn(GRID_TD, "w-32")}>
          <div className="h-1.5 w-24 bg-slate-800 rounded-full overflow-hidden flex">
            {familyRows.map(r => (
              <div
                key={r.family}
                className={cn("h-full", FAMILY_BAR_COLOR[r.family])}
                style={{ width: `${(r.contribution / maxScore) * 100}%` }}
              />
            ))}
          </div>
        </td>

        <td className={cn(GRID_TD, "text-right")}>
          <span className={cn(
            "inline-flex items-center gap-1.5 text-xs font-semibold text-white/80 transition-colors",
            state.status === "loading" && "opacity-50",
          )}>
            {state.status === "loading" ? "…" : "Why"}
            <ChevronDown className={cn("w-3 h-3 transition-transform", isExpanded && "rotate-180")} />
          </span>
        </td>
      </tr>

      {isExpanded && (
        <tr>
        <td colSpan={COL_COUNT} className="p-0">
        <div className="px-3 pl-9 py-1.5 space-y-1.5 bg-black/50 border-b border-[#d4af37]/15">
          {/* Metric table: every scored metric, its value, weight, and real peer comparison */}
          {metricRows.length > 0 && (
            <div>
              <p className="text-[9px] uppercase tracking-widest text-white/30 mb-0.5">
                {score.peerGroupName
                  ? <span className="text-white/50 normal-case tracking-normal">{score.peerGroupName} ({score.peerGroupSize ?? metricRows[0]?.groupN ?? "?"} peers)</span>
                  : <span className="text-white/40 normal-case tracking-normal">unclassified — vs full {allScores.length}-ticker market</span>}
                {score.styleBucket && (
                  <span className="text-white/40 normal-case tracking-normal ml-2">· style {score.styleBucket.replace(/_/g, " ")}</span>
                )}
                {score.companyScore != null && (
                  <span className="text-white/40 normal-case tracking-normal ml-2">
                    · Co {score.companyScore.toFixed(0)}
                    {score.sectorScore != null ? ` / Sec ${score.sectorScore.toFixed(0)}` : ""}
                  </span>
                )}
              </p>
              <div className={GRID_WRAP}>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className={GRID_HEADER}>
                      <th className={cn(GRID_TH, "text-left py-0.5")}>Metric</th>
                      <th className={cn(GRID_TH, "text-right py-0.5")}>Value</th>
                      <th className={cn(GRID_TH, "text-right py-0.5")}>Wt</th>
                      <th className={cn(GRID_TH, "text-right py-0.5")}>Percentile</th>
                      <th className={cn(GRID_TH, "text-right py-0.5")}>Sector med (range)</th>
                      <th className={cn(GRID_TH, "text-right py-0.5")}>Mkt med</th>
                      <th className={cn(GRID_TH, "text-right py-0.5")}>z</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metricRows.map((row, i) => (
                      <tr key={row.key} className={gridRow(i)}>
                        <td className={cn(GRID_TD, ROW_CELL, "text-left text-white/80")}>{row.label}</td>
                        <td className={cn(GRID_TD, ROW_CELL, "text-right font-mono text-white font-semibold")}>{row.valueStr}</td>
                        <td className={cn(GRID_TD, ROW_CELL, "text-right font-mono text-white/40")}>{row.weight}</td>
                        <td className={cn(ROW_CELL, "py-0.5 px-2.5 text-right")}>
                          <span className={cn("inline-block px-1 rounded border text-[10px] font-mono font-semibold", percentileBadge(row.percentile))}>
                            {row.percentile}th·#{row.rankPos}/{row.n}
                          </span>
                          <span className="text-white/30 text-[9px] ml-1">({Math.round(row.sectorWeight * 100)}%)</span>
                        </td>
                        <td className={cn(GRID_TD, ROW_CELL, "text-right font-mono text-white/60")}>
                          {row.groupMedian != null ? (
                            <>
                              {row.groupMedian}
                              {row.groupMin != null && <span className="text-white/30"> ({row.groupMin}–{row.groupMax}{row.groupN != null ? `,n${row.groupN}` : ""})</span>}
                            </>
                          ) : <span className="text-white/25 italic">n/a</span>}
                        </td>
                        <td className={cn(GRID_TD, ROW_CELL, "text-right font-mono text-white/40")}>{row.peerMedian}</td>
                        <td className={cn(GRID_TD, ROW_CELL, "text-right font-mono font-semibold", zScoreColor(row.zScore))}>
                          {row.zScore >= 0 ? "+" : ""}{row.zScore.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* AI narrative — key numbers highlighted */}
          <ul className="space-y-0">
            {bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-white/70 leading-snug">
                <span className="text-white/30 shrink-0">•</span>
                <span>{highlightBullet(b)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-white/30">AI narrative — not a trade recommendation.</p>
        </div>
        </td>
        </tr>
      )}
    </Fragment>
  );
});

export function RankingsLeaderboard({ scores, stocks, scoredAsOf }: RankingsLeaderboardProps) {
  const { explain, getState } = useScoreExplanation();
  const [query, setQuery] = useState("");

  if (scores.length < 2) return null;
  const maxScore = scores[0].totalScore;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scores;
    return scores.filter(s => s.ticker.toLowerCase().includes(q) || s.companyName?.toLowerCase().includes(q));
  }, [scores, query]);

  const scoredLabel = useMemo(() => {
    if (!scoredAsOf) return null;
    const d = new Date(scoredAsOf);
    if (Number.isNaN(d.getTime())) return null;
    return formatMdYy(scoredAsOf);
  }, [scoredAsOf]);

  return (
    <div className="bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-4 shadow-lg shadow-black/60">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold tracking-tight">Rankings Leaderboard</h2>
          <span className="text-xs text-muted-foreground">({scores.length})</span>
          {scoredLabel && (
            <span className="text-[10px] text-muted-foreground/80" title="fund_score_computed_at">
              {scoredLabel}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {FAMILY_ORDER.map(fam => (
            <span key={fam} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className={cn("w-2 h-2 rounded-sm", FAMILY_BAR_COLOR[fam])} />
              {FAMILY_LABEL[fam]}
            </span>
          ))}
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-gray-500 absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter ticker..."
            className="h-7 w-36 pl-7 pr-2 text-xs rounded-md border border-white/20 bg-white text-black placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>
      </div>

      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-center w-8")}>#</th>
              <th className={cn(GRID_TH, "text-left")}>Ticker</th>
              {FAMILY_ORDER.map(fam => (
                <th key={fam} className={cn(GRID_TH, "text-right")}>{FAMILY_LABEL[fam]}</th>
              ))}
              <th className={cn(GRID_TH, "text-right")} title="Blended fund total (≈90% company + 10% sector opportunity)">Score</th>
              <th className={cn(GRID_TH, "text-right")} title="Style bucket — sets Value/Growth/Quality/Safety weights">Style</th>
              <th className={cn(GRID_TH, "text-right")} title="Company score / sector opportunity layer">Co/Sec</th>
              <th className={cn(GRID_TH, "text-left")}>Breakdown</th>
              <th className={cn(GRID_TH, "text-right")}></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={COL_COUNT} className="text-xs text-muted-foreground py-2 px-2.5">No tickers match "{query}".</td></tr>
            ) : (
              filtered.map((score, i) => (
                <LeaderboardRow
                  allScores={scores}
                  explainState={getState(score.ticker, "fundamental")}
                  key={score.ticker}
                  score={score}
                  idx={score.rank - 1}
                  rowIdx={i}
                  maxScore={maxScore}
                  stocks={stocks}
                  explain={explain}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
