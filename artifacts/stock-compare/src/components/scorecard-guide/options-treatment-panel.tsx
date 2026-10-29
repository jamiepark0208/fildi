/**
 * Scorecard Guide › Options — live ticker walkthrough (put strike score).
 * Total → strike-component weights → readings from the latest snapshot.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  W_INCOME,
  W_BUFFER,
  W_IV_RELATIVE,
  W_IV_ABSOLUTE,
  W_STOCK_QUALITY,
  W_SUPPORT,
  W_DTE,
  W_NODE_GAP,
} from "@/lib/option-scorer-constants";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { GuideMetricGrid } from "@/components/scorecard-guide/guide-metric-grid";
import { OPTIONS_STOCK_ROWS, OPTIONS_STRIKE_ROWS } from "@/lib/scorecard-guide-metadata";
import {
  ComponentMetricCard,
  WalkDriversTable,
  WalkScoreHeader,
  walkAccent,
  type WalkComponent,
} from "./score-walkthrough-shared";

type OptComp = { score: number | null; weight: number };

type OptionRankingRow = {
  ticker: string;
  side: string;
  asOf: string;
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
  componentScores: Record<string, OptComp | unknown>;
  rank?: number;
  earningsRisk?: boolean;
  confidence?: string | null;
};

const STRIKE_META: Array<{ key: string; label: string; defaultW: number }> = [
  { key: "income", label: "Income", defaultW: W_INCOME },
  { key: "buffer", label: "Buffer", defaultW: W_BUFFER },
  { key: "ivRelative", label: "IV relative", defaultW: W_IV_RELATIVE },
  { key: "ivAbsolute", label: "IV absolute", defaultW: W_IV_ABSOLUTE },
  { key: "stockQuality", label: "Stock quality", defaultW: W_STOCK_QUALITY },
  { key: "support", label: "Support", defaultW: W_SUPPORT },
  { key: "dte", label: "DTE fit", defaultW: W_DTE },
  { key: "nodeGap", label: "Node gap", defaultW: W_NODE_GAP },
  { key: "volOfVol", label: "Vol of vol", defaultW: 0 },
];

function asComp(v: unknown): OptComp | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!("score" in o) && !("weight" in o)) return null;
  const score = o.score == null ? null : Number(o.score);
  const weight = Number(o.weight ?? 0);
  return {
    score: score != null && Number.isFinite(score) ? score : null,
    weight: Number.isFinite(weight) ? weight : 0,
  };
}

function OptionsWalkthrough({ ticker }: { ticker: string }) {
  const { data, error, isFetching } = useQuery({
    queryKey: ["options", "rankings", "put", "guide"],
    queryFn: async (): Promise<{ rows: OptionRankingRow[]; asOf: string | null }> => {
      const res = await fetch("/api/options/rankings?side=put", { credentials: "include" });
      if (!res.ok) throw new Error("options/rankings failed");
      const body = await res.json();
      // API: { side, asOf, rankings: [...] }
      if (Array.isArray(body)) return { rows: body, asOf: body[0]?.asOf ?? null };
      const list = (body.rankings ?? body.rows ?? []) as OptionRankingRow[];
      return { rows: list, asOf: body.asOf ?? null };
    },
    staleTime: 5 * 60_000,
  });

  const subject = data?.rows.find((r) => r.ticker === ticker);

  const components: WalkComponent[] = useMemo(() => {
    if (!subject) return [];
    const cs = subject.componentScores ?? {};
    return STRIKE_META.map((meta, i) => {
      const c = asComp(cs[meta.key]);
      const accent = walkAccent(i);
      const w = c?.weight ?? meta.defaultW;
      const score01 = c?.score ?? null;
      const score100 = score01 != null ? score01 * 100 : null;
      const weightPct = Math.round(w * 100);
      const contribution =
        score01 != null && w > 0 ? parseFloat((score01 * w * 100).toFixed(2)) : null;
      const drivers: WalkComponent["drivers"] = [];
      if (meta.key === "income" && subject.weeklyIncomePct != null) {
        drivers.push({
          label: "Weekly income",
          detail: `${subject.weeklyIncomePct.toFixed(2)}%/wk`,
          tip: "Premium / spot annualized to a weekly yield.",
        });
      }
      if (meta.key === "buffer") {
        if (subject.otmPct != null)
          drivers.push({
            label: "OTM buffer",
            detail: `${subject.otmPct.toFixed(1)}%`,
            tip: "How far the strike sits from spot.",
          });
        if (subject.delta != null)
          drivers.push({
            label: "Delta",
            detail: subject.delta.toFixed(2),
            tip: "Strike delta from the chain.",
          });
      }
      if (meta.key === "ivRelative" || meta.key === "ivAbsolute") {
        if (subject.strikeIv != null)
          drivers.push({
            label: "Strike IV",
            detail: `${(subject.strikeIv * (subject.strikeIv > 2 ? 1 : 100)).toFixed(1)}%`,
            tip: "Implied vol on the chosen strike.",
          });
      }
      if (meta.key === "dte" && subject.dte != null) {
        drivers.push({
          label: "Days to expiry",
          detail: `${Math.round(subject.dte)}d`,
          tip: "~7d weekly preferred for puts.",
        });
      }
      if (meta.key === "support" && subject.otmPct != null) {
        drivers.push({
          label: "Strike vs spot",
          detail: `${subject.strike.toFixed(0)} / ${subject.spot.toFixed(0)}`,
        });
      }
      if (drivers.length === 0 && score01 != null) {
        drivers.push({
          label: "Component score",
          detail: `${score100!.toFixed(0)} / 100`,
          tip: "Normalized 0–1 component from the strike scorer.",
        });
      }
      return {
        key: meta.key,
        label: meta.label,
        score: score100,
        weightPct,
        contribution,
        edgeClass: accent.edge,
        textClass: accent.text,
        displayOnly: w === 0,
        drivers,
      };
    }).filter((c) => !c.displayOnly || c.score != null);
  }, [subject]);

  const driverRows = useMemo(() => {
    return components
      .filter((c) => !c.displayOnly)
      .flatMap((c) =>
        c.drivers.map((d) => ({
          name: d.label,
          fam: c.label,
          raw: d.detail,
          pts: c.contribution != null ? c.contribution.toFixed(2) : "—",
          tip: d.tip,
        })),
      );
  }, [components]);

  if (error) {
    return (
      <p className="text-[11px] text-amber-300">
        {(error as Error).message || "Options rankings unavailable."}
      </p>
    );
  }

  if (!subject && !isFetching) {
    return (
      <p className="text-[11px] text-amber-300">
        {ticker} not on the latest put options board — try a Model List / scanner name.
      </p>
    );
  }

  if (!subject) {
    return <p className="text-[11px] text-white">Loading options rankings…</p>;
  }

  const rank =
    subject.rank ??
    (data?.rows.findIndex((r) => r.ticker === ticker) ?? -1) + 1;

  return (
    <div className="space-y-2">
      <WalkScoreHeader
        total={subject.optionScore}
        title="Option (strike) score for the chosen put — weighted components from the nightly snapshot."
        chips={[
          {
            label: "put",
            value: `${subject.strike.toFixed(0)} ${subject.expiry}`,
            tip: "Best put strike/expiry persisted for this as-of.",
            className: "text-[#f0d78c]",
          },
          {
            label: "board rank",
            value: rank > 0 ? `#${rank}` : "—",
            tip: "Rank on the put options board for this as-of.",
          },
          {
            label: "income",
            value:
              subject.weeklyIncomePct != null
                ? `${subject.weeklyIncomePct.toFixed(2)}%/wk`
                : "—",
            className: "text-emerald-300",
            tip: "Weekly premium yield on the chosen strike.",
          },
          {
            label: "as of",
            value: String(subject.asOf).slice(0, 10),
            tip: "Snapshot date for this board.",
          },
          ...(subject.earningsRisk
            ? [
                {
                  label: "earnings",
                  value: "risk",
                  tip: "Earnings before expiry — score haircut applied.",
                  className: "text-amber-300",
                },
              ]
            : []),
        ]}
      />

      <div className="space-y-1">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-white">
          How {ticker} put scored {subject.optionScore.toFixed(0)}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
          {components.map((c) => (
            <ComponentMetricCard key={c.key} c={c} />
          ))}
        </div>
        <p className="text-[10px] text-white">
          Strike layer only (BEST put). Stock-rank layer (technical / fund / relative move) orders
          which names get scanned — see catalog below.
        </p>
      </div>

      <WalkDriversTable title={`Strike drivers · ${ticker}`} rows={driverRows} />
    </div>
  );
}

export function OptionsTreatmentPanel({ ticker = "HOOD" }: { ticker?: string }) {
  const { weights } = useScoringPreferences();
  return (
    <div className="space-y-2.5">
      <OptionsWalkthrough ticker={ticker} />
      <details className="rounded-sm border border-white/10 bg-black/30">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white hover:text-[#d4af37]">
          Options weight catalogs (stock rank + strike)
        </summary>
        <div className="px-2 pb-2 pt-1 space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[#d4af37]">
            Stock rank layer
          </p>
          <GuideMetricGrid
            rows={OPTIONS_STOCK_ROWS}
            coverageLabel="DB"
            config={weights}
            editable={false}
          />
          <p className="text-[10px] font-semibold uppercase tracking-wide text-[#d4af37]">
            Strike pick layer
          </p>
          <GuideMetricGrid
            rows={OPTIONS_STRIKE_ROWS}
            coverageLabel="On scan"
            config={weights}
            editable={false}
          />
        </div>
      </details>
    </div>
  );
}
