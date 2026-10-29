/**
 * Scorecard Guide › Technical — live ticker walkthrough.
 * Same shape as fund: total → weight bar → components → all drivers.
 * Relative Pressure / Analyst Upside stay context (S042 / A155) — not in total.
 * TV indicators (UT/ST/SMC/F&G) are Scanner context (S102) — not score inputs.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  computeTechnicalRankingsV2,
  TECHNICAL_SCORECARD_METRICS_V2,
  COMPONENT_EXPLAINERS,
  type TechnicalRow,
  type TechnicalScore,
} from "@/lib/technical-rankings";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { GuideMetricGrid } from "@/components/scorecard-guide/guide-metric-grid";
import { TECHNICAL_GUIDE_ROWS } from "@/lib/scorecard-guide-metadata";
import {
  ComponentMetricCard,
  ComponentWeightBar,
  WalkDriversTable,
  WalkScoreHeader,
  walkAccent,
  type WalkComponent,
} from "./score-walkthrough-shared";
import { DataTip } from "@/components/data-tip";
import { cn } from "@/lib/utils";

function TechnicalWalkthrough({ ticker }: { ticker: string }) {
  const { weights } = useScoringPreferences();
  const { data: rows, error, isFetching } = useQuery({
    queryKey: ["technicals", "all", "guide"],
    queryFn: async (): Promise<TechnicalRow[]> => {
      const res = await fetch("/api/technicals/all", { credentials: "include" });
      if (!res.ok) throw new Error("technicals/all failed");
      return res.json();
    },
    staleTime: 60 * 60_000,
  });

  const scored = useMemo(() => {
    if (!rows?.length) return [] as TechnicalScore[];
    return computeTechnicalRankingsV2(rows, {}, weights.technical, "put");
  }, [rows, weights.technical]);

  const subject = scored.find((s) => s.ticker === ticker);
  const row = rows?.find((r) => r.ticker === ticker);

  const components: WalkComponent[] = useMemo(() => {
    if (!subject?.componentScores) return [];
    const explainers = COMPONENT_EXPLAINERS;
    return TECHNICAL_SCORECARD_METRICS_V2.map((meta, i) => {
      const cs = subject.componentScores![meta.key];
      const accent = walkAccent(i);
      const parts = row && explainers[meta.key] ? explainers[meta.key]!(row) : [];
      const sorted = [...parts].sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
      const score01 = cs?.score ?? null;
      const score100 = score01 != null ? score01 * 100 : null;
      const w = cs?.weight ?? meta.weight;
      const weightPct = Math.round(w * 100);
      const contribution =
        score01 != null && w > 0 ? parseFloat((score01 * w * 100).toFixed(2)) : null;
      return {
        key: meta.key,
        label: meta.label,
        score: score100,
        weightPct,
        contribution,
        edgeClass: accent.edge,
        textClass: accent.text,
        barClass: accent.bar,
        displayOnly: meta.weight === 0,
        drivers: sorted.map((p) => ({
          label: p.label,
          detail: p.raw,
          tip: `${p.label}: ${p.raw} → sub-score ${(p.score * 100).toFixed(0)}`,
        })),
      };
    });
  }, [subject, row]);

  const weighted = useMemo(() => components.filter((c) => !c.displayOnly), [components]);
  const contextOnly = useMemo(() => components.filter((c) => c.displayOnly && c.score != null), [components]);

  const driverRows = useMemo(() => {
    const out: Array<{ name: string; fam: string; raw: string; pts: string; tip?: string }> = [];
    for (const c of weighted) {
      for (const d of c.drivers) {
        out.push({
          name: d.label,
          fam: c.label,
          raw: d.detail,
          pts: c.contribution != null ? c.contribution.toFixed(2) : "—",
          tip: d.tip,
        });
      }
    }
    return out;
  }, [weighted]);

  if (error) {
    return (
      <p className="text-[11px] text-amber-300">
        {(error as Error).message || `No technicals for ${ticker}.`}
      </p>
    );
  }

  if (!subject && !isFetching) {
    return (
      <p className="text-[11px] text-amber-300">
        {ticker} not in technicals universe — load another ticker or refresh technicals.
      </p>
    );
  }

  if (!subject) {
    return <p className="text-[11px] text-white">Loading technicals…</p>;
  }

  return (
    <div className="space-y-2">
      <WalkScoreHeader
        total={subject.totalScore}
        title="Technical total = weighted average of the 6 scoring components (0–100). Self-relative — peers do not change your score."
        chips={[
          {
            label: "signal",
            value: subject.signal,
            tip: "GO / WATCH / NO from thresholds on the total.",
            className: "text-[#f0d78c]",
          },
          {
            label: "univ rank",
            value: `#${subject.rank}`,
            tip: "Rank among scored technicals (1 = best).",
          },
          {
            label: "regime",
            value: subject.regime ?? "—",
            tip: "Chart regime used inside Trend Context.",
            className: "text-violet-300",
          },
          {
            label: "coverage",
            value:
              subject.dataQuality != null
                ? `${Math.round(subject.dataQuality * 100)}%`
                : "—",
            tip: "Share of component weight with a reading.",
            className: "text-sky-300",
          },
        ]}
      />

      <div className="space-y-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-white">
            How {ticker} got {subject.totalScore.toFixed(0)}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {weighted.map((c) => (
              <span key={c.key} className={cn("text-[9px] font-semibold uppercase", c.textClass)}>
                {c.label.split(" ")[0]}
              </span>
            ))}
          </div>
        </div>
        <ComponentWeightBar
          components={weighted.map((c) => ({
            key: c.key,
            label: c.label,
            weightPct: c.weightPct,
            score: c.score,
            contribution: c.contribution,
            barClass: c.barClass ?? "bg-zinc-500",
          }))}
        />
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-3 gap-1.5">
          {weighted.map((c) => (
            <ComponentMetricCard key={c.key} c={c} />
          ))}
        </div>
      </div>

      {contextOnly.length > 0 && (
        <div className="space-y-1">
          <DataTip tip="S042 / S042b: relativePressure and analystUpside did not predict forward returns or put-kept — kept out of the 6-comp total (A155). Still shown as desk context.">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-white cursor-help">
              Context (not in total) · {ticker}
            </div>
          </DataTip>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {contextOnly.map((c) => (
              <ComponentMetricCard key={c.key} c={c} />
            ))}
          </div>
        </div>
      )}

      <WalkDriversTable title={`Metric drivers · ${ticker}`} rows={driverRows} />

      <details className="rounded-sm border border-white/10 bg-black/30">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white hover:text-[#d4af37]">
          TradingView indicators (UT / SuperTrend / SMC / F&amp;G) — why not here
        </summary>
        <div className="px-2.5 pb-2 space-y-1 text-[10px] text-white leading-snug">
          <p>
            Built in <span className="text-[#d4af37]">indicators_daily</span> (UT Bot, SuperTrend
            cluster/div, SMC sweep/BOS/FVG/OB, Fear &amp; Greed). Surfaced on Rankings › Sell Puts
            tooltips and Model List tech chips — not in this 6-comp technical total.
          </p>
          <p>
            S102: 17/17 sold-put filter splits failed. S103/S105/S106: timing / trail / call-timing
            also failed as score gates. Desk uses them as{" "}
            <span className="text-[#d4af37]">context</span>, not score weight.
          </p>
        </div>
      </details>
    </div>
  );
}

export function TechnicalTreatmentPanel({ ticker = "HOOD" }: { ticker?: string }) {
  const { weights } = useScoringPreferences();
  return (
    <div className="space-y-2.5">
      <TechnicalWalkthrough ticker={ticker} />
      <details className="rounded-sm border border-white/10 bg-black/30">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white hover:text-[#d4af37]">
          Technical weights catalog ({TECHNICAL_GUIDE_ROWS.length})
        </summary>
        <div className="px-2 pb-2 pt-1">
          <GuideMetricGrid
            rows={TECHNICAL_GUIDE_ROWS}
            coverageLabel="DB daily"
            config={weights}
            editable={false}
          />
        </div>
      </details>
    </div>
  );
}
