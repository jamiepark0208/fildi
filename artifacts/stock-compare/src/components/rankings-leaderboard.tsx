import { memo, useState, useEffect } from "react";
import { StockScore } from "@/lib/rankings";
import { StockMetrics } from "@workspace/api-client-react";
import { Trophy, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useScoreExplanation } from "@/hooks/useScoreExplanation";

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

function parseBullets(text: string): string[] {
  return text
    .split(/\n|(?<=[.!?])\s{1,2}(?=[A-Z•\-])/)
    .map(s => s.replace(/^[-•*]\s*/, "").trim())
    .filter(s => s.length > 8);
}

function buildFundamentalPayload(score: StockScore, stocks?: StockMetrics[]) {
  const metricEntries = Object.entries(score.metricScores)
    .filter(([, v]) => v.value != null)
    .sort((a, b) => b[1].weightedScore - a[1].weightedScore);
  const fs = score.familyScores;
  const stockData = stocks?.find(s => s.ticker === score.ticker);
  return {
    fundamentalData: {
      totalScore: score.totalScore,
      rank: score.rank,
      familyScores: {
        value:   fs?.value.score   ?? 50,
        growth:  fs?.growth.score  ?? 50,
        quality: fs?.quality.score ?? 50,
        safety:  fs?.safety.score  ?? 50,
      },
      topMetrics:     metricEntries.slice(0, 4).map(([k]) => k),
      weakMetrics:    metricEntries.slice(-4).map(([k]) => k),
      reason:         score.reason,
      suspectMetrics: score.suspectMetrics,
      dataQuality:    score.dataQuality,
      sector:         stockData?.sector   ?? undefined,
      industry:       stockData?.industry ?? undefined,
      metricValues:   Object.fromEntries(metricEntries.map(([k, v]) => [k, v.value])),
    },
  };
}

export interface MetricRow {
  label: string;
  value: string;
  zScore: number;
}

function metricLabel(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase()).trim();
}

function metricValueStr(val: number): string {
  if (Math.abs(val) >= 1000) return val.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (Math.abs(val) >= 10) return val.toFixed(1);
  return val.toFixed(2);
}

function buildMetricRows(score: StockScore, allScores: StockScore[]): MetricRow[] {
  const top = Object.entries(score.metricScores)
    .filter(([, v]) => v.value != null)
    .sort((a, b) => Math.abs(b[1].weightedScore) - Math.abs(a[1].weightedScore))
    .slice(0, 5);

  return top.map(([key, mv]) => {
    const rawVal = mv.value ?? 0;
    const peerVals = allScores
      .map(s => s.metricScores[key]?.value)
      .filter((v): v is number => v != null);
    const mean = peerVals.reduce((a, b) => a + b, 0) / peerVals.length;
    const std = Math.sqrt(peerVals.reduce((a, b) => a + (b - mean) ** 2, 0) / peerVals.length);
    return {
      label: metricLabel(key),
      value: metricValueStr(rawVal),
      zScore: std > 0 ? (rawVal - mean) / std : 0,
    };
  });
}

interface RowProps {
  score: StockScore;
  idx: number;
  maxScore: number;
  allScores: StockScore[];
  stocks?: StockMetrics[];
  explain: ReturnType<typeof useScoreExplanation>["explain"];
  getState: ReturnType<typeof useScoreExplanation>["getState"];
}

function zScoreColor(z: number): string {
  if (z >= 1.5) return "text-emerald-400";
  if (z >= 0.5) return "text-emerald-300/80";
  if (z <= -1.5) return "text-red-400";
  if (z <= -0.5) return "text-red-300/80";
  return "text-white/50";
}

function shortenBullet(text: string): string {
  const clean = text.replace(/\*\*/g, "").replace(/^\s*[-•]\s*/, "").trim();
  const sentence = clean.split(/(?<=[.!?])\s/)[0];
  return sentence.length > 120 ? sentence.slice(0, 117) + "…" : sentence;
}

const LeaderboardRow = memo(function LeaderboardRow({ score, idx, maxScore, allScores, stocks, explain, getState }: RowProps) {
  const state = getState(score.ticker, "fundamental");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (state.status === "done" && state.text) setOpen(true);
  }, [state.status, state.text]);

  const isExpanded = state.status === "done" && !!state.text && open;
  const metricRows = isExpanded ? buildMetricRows(score, allScores) : [];
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

        <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
          <div
            className={cn(
              "h-full rounded-full",
              idx === 0 ? "bg-yellow-500" : idx === 1 ? "bg-slate-400" : idx === 2 ? "bg-amber-700" : "bg-primary/60"
            )}
            style={{ width: `${(score.totalScore / maxScore) * 100}%` }}
          />
        </div>

        <button
          onClick={() => {
            if (state.status === "done") setOpen(!open);
            else explain(score.ticker, "fundamental", buildFundamentalPayload(score, stocks));
          }}
          disabled={state.status === "loading"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white/80 hover:text-white transition-colors shrink-0 disabled:opacity-50"
        >
          {state.status === "loading" ? "…" : "Why"}
          <ChevronDown className={cn("w-3 h-3 transition-transform", isExpanded && "rotate-180")} />
        </button>
      </div>

      {isExpanded && (
        <div className="mt-2.5 mb-1 pl-9 space-y-2.5">
          {/* Metric table */}
          {metricRows.length > 0 && (
            <table className="w-full text-[11px] border-collapse">
              <thead>
                <tr className="border-b border-white/10">
                  <th className="text-left pb-1 text-white/40 font-medium">Metric</th>
                  <th className="text-right pb-1 text-white/40 font-medium pr-3">Value</th>
                  <th className="text-right pb-1 text-white/40 font-medium">vs Peers</th>
                </tr>
              </thead>
              <tbody>
                {metricRows.map((row, i) => (
                  <tr key={i} className="border-b border-white/5 last:border-0">
                    <td className="py-1 text-white/80">{row.label}</td>
                    <td className="py-1 pr-3 text-right font-mono text-white/70">{row.value}</td>
                    <td className={cn("py-1 text-right font-mono font-semibold", zScoreColor(row.zScore))}>
                      {row.zScore >= 0 ? "+" : ""}{row.zScore.toFixed(1)}σ
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {/* Shortened bullets */}
          <ul className="space-y-1">
            {bullets.map((b, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-white/70 leading-relaxed">
                <span className="text-white/30 shrink-0 mt-0.5">•</span>
                {b}
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

  if (scores.length < 2) return null;
  const maxScore = scores[0].totalScore;

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-3">
        <Trophy className="w-4 h-4 text-primary" />
        <h2 className="text-sm font-bold tracking-tight">Rankings Leaderboard</h2>
      </div>

      <div className="flex flex-col gap-0.5">
        {scores.map((score, idx) => (
          <LeaderboardRow
            allScores={scores}
            key={score.ticker}
            score={score}
            idx={idx}
            maxScore={maxScore}
            stocks={stocks}
            explain={explain}
            getState={getState}
          />
        ))}
      </div>
    </div>
  );
}
