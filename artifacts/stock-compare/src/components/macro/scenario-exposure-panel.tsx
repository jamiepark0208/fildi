/**
 * A149 — Macro › Scenario: realized factor beta (baked) + OpenJev business-description why.
 */
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { formatMdYy } from "@/lib/format";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";

type Side = {
  ticker: string;
  peerGroup: string;
  score: number;
  beta: number | null;
  rank: number;
};
type ScenarioSlice = {
  available: boolean;
  scenario: string;
  label: string;
  note: string;
  source?: string;
  hurt: Side[];
  helped: Side[];
  bookScored?: number;
  bookSize?: number;
  cacheSize?: number;
  betaCovered?: number;
  scoresAsOf?: string | null;
  betasAsOf?: string | null;
  /** legacy */
  covered?: number;
  universe?: number;
};
type Resp = ScenarioSlice & {
  scenarios: { id: string; label: string }[];
  byScenario?: Record<string, ScenarioSlice>;
};

function betaLabel(beta: number | null): { text: string; tone: string } {
  if (beta == null) return { text: "—", tone: "text-amber-100/80" };
  const t = `${beta >= 0 ? "+" : ""}${beta.toFixed(2)}`;
  if (beta <= -0.3) return { text: t, tone: "text-red-400" };
  if (beta >= 0.3) return { text: t, tone: "text-emerald-400" };
  return { text: t, tone: "text-amber-100" };
}

function Col({
  title,
  hint,
  rows,
}: {
  title: string;
  hint: string;
  rows: Side[];
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-1" title={hint}>
        <div className="text-[10px] font-bold uppercase tracking-wide text-[#d4af37]">{title}</div>
        <div className="text-[10px] text-white/75 leading-snug">{hint}</div>
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-amber-100">No book names scored yet</p>
      ) : (
        <div className={GRID_WRAP}>
          <table className="w-full border-collapse">
            <thead>
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "text-left")}>Ticker</th>
                <th className={cn(GRID_TH, "text-right")} title="Realized factor beta beyond SPY (signed)">
                  Beta
                </th>
                <th className={cn(GRID_TH, "text-right")} title="OpenJev business-description fit (−1…+1)">
                  OJ
                </th>
                <th className={cn(GRID_TH, "text-left")}>Group</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const b = betaLabel(r.beta);
                const group = r.peerGroup.replace(/^[^.]+\./, "").replace(/_/g, " ");
                return (
                  <tr
                    key={r.ticker}
                    className={gridRow(i)}
                    title={`Beta ${r.beta != null ? r.beta.toFixed(3) : "n/a"} · OpenJev ${r.score.toFixed(2)}. Not a crash %.`}
                  >
                    <td className={cn(GRID_TD, "text-white font-bold text-left")}>{r.ticker}</td>
                    <td className={cn(GRID_TD, "text-right font-semibold", b.tone)}>{b.text}</td>
                    <td className={cn(GRID_TD, "text-right text-amber-50")}>
                      {r.score >= 0 ? "+" : ""}{r.score.toFixed(2)}
                    </td>
                    <td className={cn(GRID_TD, "text-left text-amber-50 truncate max-w-[7rem]")} title={group}>
                      {group}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function fmtDay(iso: string | null | undefined): string {
  if (!iso) return "—";
  return formatMdYy(iso.length === 10 ? iso : iso.slice(0, 10));
}

export function ScenarioExposurePanel() {
  const [scenario, setScenario] = useState("credit");
  const { data: bundle, isLoading } = useQuery({
    queryKey: ["live-scenarios-all"],
    queryFn: async (): Promise<Resp> => {
      const r = await fetch(`/api/live/scenarios?scenario=${encodeURIComponent(scenario)}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 10 * 60_000,
  });

  const data = useMemo((): ScenarioSlice | undefined => {
    if (!bundle) return undefined;
    return bundle.byScenario?.[scenario] ?? (bundle.scenario === scenario ? bundle : undefined);
  }, [bundle, scenario]);

  const tabs = bundle?.scenarios ?? [
    { id: "oil", label: "Oil spikes" },
    { id: "rates", label: "Rates up" },
    { id: "ai", label: "AI spend" },
  ];

  const bookScored = data?.bookScored ?? data?.covered ?? 0;
  const bookSize = data?.bookSize ?? 0;
  const cacheSize = data?.cacheSize ?? data?.universe ?? 0;
  const betaCovered = data?.betaCovered ?? 0;
  const hasBetas = betaCovered > 0;

  return (
    <div className="rounded-md border border-[#d4af37]/20 bg-zinc-950 overflow-hidden">
      <div className="px-2.5 py-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-[#d4af37]/15">
        <span className="text-[11px] font-bold tracking-tight text-[#d4af37]">Scenario</span>
        <DataTip tip="How many of your watchlist ∪ open positions have an OpenJev score. Cache size is the full OpenJev universe (not your book).">
          <span className="text-[11px] text-white tabular-nums font-semibold">
            {data ? `${bookScored}/${bookSize || "—"} of book` : "…"}
          </span>
        </DataTip>
        <span className="text-[10px] text-amber-50/80 tabular-nums">
          {data ? `· cache ${cacheSize}` : ""}
          {hasBetas ? ` · betas ${betaCovered}/${bookScored}` : ""}
        </span>
        <span className="text-[10px] text-white/80 leading-snug w-full sm:w-auto sm:ml-auto">
          {hasBetas
            ? `Ranked by realized beta · OJ why · baked ${fmtDay(data?.betasAsOf)} · scores ${fmtDay(data?.scoresAsOf)}`
            : `Business-desc match only · scores ${fmtDay(data?.scoresAsOf)} · bake betas monthly`}
        </span>
      </div>
      <div className="px-2 py-1 flex flex-wrap gap-1 border-b border-[#d4af37]/10">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setScenario(t.id)}
            className={cn(
              "px-1.5 py-0.5 rounded text-[10px] font-semibold border transition-colors",
              scenario === t.id
                ? "bg-[#d4af37] text-black border-[#d4af37]"
                : "border-[#d4af37]/25 text-amber-100 hover:text-[#d4af37] hover:border-[#d4af37]/40",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="px-2.5 py-2 space-y-2">
        {isLoading && <p className="text-[11px] text-amber-100">Loading…</p>}
        {!isLoading && data && !data.available && (
          <p className="text-[11px] text-white/80">
            No scenarios cache — run{" "}
            <span className="font-mono text-[#d4af37]">openjev_controls.py --scenarios</span> then{" "}
            <span className="font-mono text-[#d4af37]">--bake-betas</span>.
          </p>
        )}
        {!isLoading && data?.available && (
          <>
            <p className="text-[11px] text-white leading-snug">{data.note}</p>
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
              <Col
                title="Most exposed"
                hint={`If “${data.label}” hits — book names with the worst factor beta (or OJ downside)`}
                rows={data.hurt}
              />
              <Col
                title="Least exposed"
                hint="Best (or least bad) factor beta — slight tailwind when positive"
                rows={data.helped}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
