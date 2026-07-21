import { memo, useMemo, useState, useEffect } from "react";
import { StockScore } from "@/lib/rankings";
import { StockMetrics } from "@workspace/api-client-react";
import { Trophy, ChevronDown, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScoreExplanation } from "@/hooks/useScoreExplanation";
import {
  FUNDAMENTAL_METRIC_BY_KEY, FundamentalFamily, familyWeightsForRegime, formatMetricValue,
  SECTOR_WEIGHT, MIN_SECTOR_PEERS,
} from "@/lib/fundamental-scoring-meta";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow, zScoreColor, percentileColor, percentileBadge, highlightBullet, FAMILY_BAR_COLOR } from "@/lib/score-explain-format";

interface RankingsLeaderboardProps {
  scores: StockScore[];
  stocks?: StockMetrics[];
}

const RANK_STYLE = (idx: number) =>
  idx === 0 ? "bg-yellow-500 text-yellow-950" :
  idx === 1 ? "bg-slate-400 text-slate-950"   :
  idx === 2 ? "bg-amber-700 text-amber-50"    :
              "bg-secondary text-secondary-foreground";

const ROW_STYLE = (idx: number) =>
  idx === 0 ? "border-yellow-500/30 bg-yellow-500/5" :
  idx === 1 ? "border-slate-400/30 bg-slate-400/5"   :
  idx === 2 ? "border-amber-700/30 bg-amber-700/5"   :
              "border-border/40 bg-background/30";

const FAMILY_LABEL: Record<FundamentalFamily, string> = { quality: "Quality", growth: "Growth", safety: "Safety" };

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

    let blendedPct = universePct;
    if (scoreGroup) {
      const groupVals = allScores
        .filter(s => s.peerGroupId === scoreGroup)
        .map(s => s.metricScores[key]?.value)
        .filter((v): v is number => v != null);
      if (groupVals.length >= MIN_SECTOR_PEERS) {
        const groupSorted = [...groupVals].sort((a, b) => a - b);
        const groupPct = percentileOf(rawVal, groupSorted, higherBetter);
        const sectorWeight = SECTOR_WEIGHT[key] ?? 0.5;
        blendedPct = groupPct * sectorWeight + universePct * (1 - sectorWeight);
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
    };
  }).sort((a, b) => b.percentile - a.percentile);
}

export interface FamilyBreakdownRow {
  family: FundamentalFamily;
  score: number;
  weight: number;
  contribution: number;
}

// Reproduces the family/total roll-up in computeAndPersistFundamentalScores: totalScore is a
// weighted average of the three family scores using the current macro regime's weights.
function buildFamilyBreakdown(score: StockScore): { rows: FamilyBreakdownRow[]; weightSum: number } {
  const weights = familyWeightsForRegime(score.regime);
  const fs = score.familyScores;
  const families: FundamentalFamily[] = ["quality", "growth", "safety"];
  const rows = families.map(fam => {
    const famScore = fs?.[fam]?.score ?? 50;
    const w = weights[fam];
    return { family: fam, score: famScore, weight: w, contribution: (famScore * w) / 100 };
  });
  const weightSum = families.reduce((s, f) => s + weights[f], 0);
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
      // Real cross-sectional numbers — instructs the model to cite these instead of guessing.
      metricDetails:  Object.fromEntries(metricRows.map(r => [r.label, {
        value: r.valueStr, percentile: r.percentile, peerMedian: r.peerMedian, n: r.n,
      }])),
    },
  };
}

interface ExplainState { text: string; status: "idle" | "loading" | "done" | "error"; }

interface RowProps {
  score: StockScore;
  idx: number;
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

const LeaderboardRow = memo(function LeaderboardRow({ score, idx, maxScore, allScores, stocks, explainState, explain }: RowProps) {
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
    <div className={cn("rounded-md border px-3 py-1.5", ROW_STYLE(idx))}>
      <div className="flex items-center gap-3">
        <div className={cn(
          "w-6 h-6 rounded-full flex items-center justify-center font-bold text-[11px] shrink-0",
          RANK_STYLE(idx)
        )}>
          {score.rank}
        </div>

        <div className="w-[88px] shrink-0">
          <span className="font-mono font-bold text-sm text-white">{score.ticker}</span>
          <span className="block text-xs text-white/60 truncate max-w-[84px]">{score.companyName}</span>
        </div>

        <div className="w-[56px] shrink-0 text-right">
          <span className="font-mono font-bold text-sm text-white">{score.totalScore.toFixed(1)}</span>
          <span className="text-xs text-white/50"> pts</span>
        </div>

        <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden flex">
          {familyRows.map(r => (
            <div
              key={r.family}
              className={cn("h-full", FAMILY_BAR_COLOR[r.family])}
              style={{ width: `${(r.contribution / maxScore) * 100}%` }}
            />
          ))}
        </div>

        <button
          onClick={() => {
            if (state.status === "done") setOpen(!open);
            else explain(score.ticker, "fundamental", buildFundamentalPayload(score, allScores, stocks));
          }}
          disabled={state.status === "loading"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white/80 hover:text-white transition-colors shrink-0 disabled:opacity-50"
        >
          {state.status === "loading" ? "…" : "Why"}
          <ChevronDown className={cn("w-3 h-3 transition-transform", isExpanded && "rotate-180")} />
        </button>
      </div>

      {isExpanded && (
        <div className="mt-2.5 mb-1 pl-9 space-y-3">
          {/* Formula breakdown: Total = Σ(family score × regime weight) */}
          {familyRows.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">
                Score Formula — {score.regime ? score.regime.replace(/_/g, " ") : "default"} regime weights
              </p>
              <div className={GRID_WRAP}>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className={GRID_HEADER}>
                      <th className={cn(GRID_TH, "text-left")}>Pillar</th>
                      <th className={cn(GRID_TH, "text-right")}>Score</th>
                      <th className={cn(GRID_TH, "text-right")}>Weight</th>
                      <th className={cn(GRID_TH, "text-right")}>Contribution</th>
                    </tr>
                  </thead>
                  <tbody>
                    {familyRows.map((r, i) => (
                      <tr key={r.family} className={gridRow(i)}>
                        <td className={cn(GRID_TD, "text-left text-white/80")}>{FAMILY_LABEL[r.family]}</td>
                        <td className={cn(GRID_TD, "text-right font-mono", percentileColor(r.score))}>{r.score.toFixed(1)}</td>
                        <td className={cn(GRID_TD, "text-right font-mono text-white/50")}>{r.weight}%</td>
                        <td className={cn(GRID_TD, "text-right font-mono text-white/80")}>+{r.contribution.toFixed(1)}</td>
                      </tr>
                    ))}
                    <tr className="bg-primary/10 border-t border-border/60">
                      <td className={cn(GRID_TD, "text-left font-semibold text-white")}>Total</td>
                      <td className={GRID_TD}></td>
                      <td className={cn(GRID_TD, "text-right font-mono text-white/50")}>÷{weightSum}%</td>
                      <td className={cn(GRID_TD, "text-right font-mono font-bold text-white")}>{score.totalScore.toFixed(1)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Metric table: every scored metric, its value, weight, and real peer comparison */}
          {metricRows.length > 0 && (
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/40 mb-1">
                Metrics vs {allScores.length} tickers (blended with sector peers)
              </p>
              <div className={GRID_WRAP}>
                <table className="w-full border-collapse">
                  <thead>
                    <tr className={GRID_HEADER}>
                      <th className={cn(GRID_TH, "text-left")}>Metric</th>
                      <th className={cn(GRID_TH, "text-right")}>Value</th>
                      <th className={cn(GRID_TH, "text-right")}>Wt</th>
                      <th className={cn(GRID_TH, "text-right")}>Percentile</th>
                      <th className={cn(GRID_TH, "text-right")}>Peer Min</th>
                      <th className={cn(GRID_TH, "text-right")}>Peer Median</th>
                      <th className={cn(GRID_TH, "text-right")}>Peer Max</th>
                      <th className={cn(GRID_TH, "text-right")}>z</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metricRows.map((row, i) => (
                      <tr key={row.key} className={gridRow(i)}>
                        <td className={cn(GRID_TD, "text-left text-white/80")}>{row.label}</td>
                        <td className={cn(GRID_TD, "text-right font-mono text-white font-semibold")}>{row.valueStr}</td>
                        <td className={cn(GRID_TD, "text-right font-mono text-white/40")}>{row.weight}</td>
                        <td className="py-1.5 px-2.5 text-right">
                          <span className={cn("inline-block px-1.5 py-0.5 rounded border text-[10px] font-mono font-semibold", percentileBadge(row.percentile))}>
                            {row.percentile}th · #{row.rankPos}/{row.n}
                          </span>
                        </td>
                        <td className={cn(GRID_TD, "text-right font-mono text-white/40")}>{row.peerMin}</td>
                        <td className={cn(GRID_TD, "text-right font-mono text-white/60")}>{row.peerMedian}</td>
                        <td className={cn(GRID_TD, "text-right font-mono text-white/40")}>{row.peerMax}</td>
                        <td className={cn(GRID_TD, "text-right font-mono font-semibold", zScoreColor(row.zScore))}>
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
          <ul className="space-y-1">
            {bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-white/70 leading-relaxed">
                <span className="text-white/30 shrink-0 mt-0.5">•</span>
                <span>{highlightBullet(b)}</span>
              </li>
            ))}
          </ul>
          <p className="text-[10px] text-white/30">AI narrative — not a trade recommendation.</p>
        </div>
      )}
    </div>
  );
});

export function RankingsLeaderboard({ scores, stocks }: RankingsLeaderboardProps) {
  const { explain, getState } = useScoreExplanation();
  const [query, setQuery] = useState("");

  if (scores.length < 2) return null;
  const maxScore = scores[0].totalScore;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scores;
    return scores.filter(s => s.ticker.toLowerCase().includes(q) || s.companyName?.toLowerCase().includes(q));
  }, [scores, query]);

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-bold tracking-tight">Rankings Leaderboard</h2>
          <span className="text-xs text-muted-foreground">({scores.length})</span>
        </div>
        <div className="flex items-center gap-3">
          {(Object.keys(FAMILY_LABEL) as FundamentalFamily[]).map(fam => (
            <span key={fam} className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <span className={cn("w-2 h-2 rounded-sm", FAMILY_BAR_COLOR[fam])} />
              {FAMILY_LABEL[fam]}
            </span>
          ))}
        </div>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-muted-foreground absolute left-2 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Filter ticker..."
            className="h-7 w-36 pl-7 pr-2 text-xs rounded-md border border-border bg-background/50 focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      </div>

      <div className="flex flex-col gap-0.5">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">No tickers match "{query}".</p>
        ) : (
          filtered.map((score) => (
            <LeaderboardRow
              allScores={scores}
              explainState={getState(score.ticker, "fundamental")}
              key={score.ticker}
              score={score}
              idx={score.rank - 1}
              maxScore={maxScore}
              stocks={stocks}
              explain={explain}
            />
          ))
        )}
      </div>
    </div>
  );
}
