import {
  STYLE_FAMILY_WEIGHTS,
  TREATMENT_FLOW,
  SCORE_PIPELINE_STEPS,
  ENGINE_METRICS,
  CROSS_SECTION_BLEND,
  SPECIALTY_GAP_NOTES,
  type StyleBucket,
  type FamilyName,
} from "@/lib/fund-score-treatments";

const STYLE_ORDER: StyleBucket[] = [
  "value",
  "growth",
  "garp",
  "blend",
  "quality_defensive",
  "pre_revenue",
  "financial",
];

const FAM_ORDER: FamilyName[] = ["value", "growth", "quality", "safety"];
const pct = (w: number) => CROSS_SECTION_BLEND.pct(w);

/** Scorecard Guide — how the persisted fundamental score is built (trader-facing). */
export function FundamentalTreatmentPanel() {
  return (
    <div className="space-y-3 rounded-md border border-[#d4af37]/25 bg-zinc-950/80 p-3">
      <div>
        <h2 className="text-xs font-semibold text-[#d4af37]/90 uppercase tracking-wide">
          Fundamental score
        </h2>
        <p className="text-[11px] text-amber-200/55 mt-1 leading-snug">
          Peer-relative stock quality used on rankings, Model List, and options stockQuality.
          Missing metrics drop out of the blend — they are not scored as zero.
        </p>
      </div>

      <div className="rounded border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2 text-[11px] text-emerald-200/85 leading-snug">
        Each metric is ranked{" "}
        <span className="font-semibold tabular-nums">{pct(CROSS_SECTION_BLEND.peer)}% vs peers</span>
        ,{" "}
        <span className="font-semibold tabular-nums">{pct(CROSS_SECTION_BLEND.sector)}% vs sector</span>
        ,{" "}
        <span className="font-semibold tabular-nums">{pct(CROSS_SECTION_BLEND.universe)}% vs all stocks</span>
        . Thin peer groups lean more on sector / universe.
      </div>

      <div className="rounded border border-sky-500/25 bg-sky-500/5 px-2.5 py-2 text-[11px] text-sky-100/80 leading-snug">
        <span className="font-semibold text-sky-200/90">Street research (IBES): </span>
        revision breadth and FY1→FY2 EPS growth feed the growth family when available.
        No IBES coverage → those inputs are skipped, not penalized.
      </div>

      <div>
        <h3 className="text-[11px] font-semibold text-white mb-1">How it runs</h3>
        <ol className="space-y-0.5 list-decimal list-inside text-[11px] text-amber-200/70">
          {SCORE_PIPELINE_STEPS.map((s) => (
            <li key={s} className="leading-snug">{s}</li>
          ))}
        </ol>
      </div>

      <div>
        <h3 className="text-[11px] font-semibold text-white mb-1.5">Style routing</h3>
        <div className="space-y-1.5">
          {TREATMENT_FLOW.map((step, i) => (
            <div key={step.id} className="rounded border border-[#d4af37]/15 bg-black/40 px-2.5 py-1.5">
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-mono text-[#d4af37]/70">{i + 1}</span>
                <span className="text-[11px] font-semibold text-white">{step.title}</span>
              </div>
              <p className="text-[10px] text-amber-200/50 mt-0.5">
                When: {step.detector}
              </p>
              <p className="text-[10px] text-emerald-400/80">{step.action}</p>
              {step.metricEffects.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {step.metricEffects.map((e) => (
                    <li key={e} className="text-[10px] text-amber-200/55 pl-2 border-l border-[#d4af37]/20">
                      {e}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-[11px] font-semibold text-white mb-1.5">
          Family weights by style (%)
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] border-collapse min-w-[420px]">
            <thead>
              <tr className="border-b border-[#d4af37]/25 text-[#d4af37]/80">
                <th className="text-left py-1 pr-2 font-semibold">Style</th>
                {FAM_ORDER.map((f) => (
                  <th key={f} className="text-right py-1 px-1 font-semibold capitalize">
                    {f}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {STYLE_ORDER.map((style) => {
                const w = STYLE_FAMILY_WEIGHTS[style];
                return (
                  <tr key={style} className="border-b border-zinc-800/80 text-amber-200/70">
                    <td className="py-1 pr-2 font-mono text-white/90">{style}</td>
                    {FAM_ORDER.map((f) => (
                      <td key={f} className="text-right py-1 px-1 tabular-nums">
                        {w[f]}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-[11px] font-semibold text-white mb-1.5">
          Metrics ({ENGINE_METRICS.length})
        </h3>
        <div className="overflow-x-auto max-h-64 overflow-y-auto rounded border border-[#d4af37]/15">
          <table className="w-full text-[10px] border-collapse min-w-[480px]">
            <thead className="sticky top-0 bg-black text-[#d4af37]/80">
              <tr className="border-b border-[#d4af37]/25">
                <th className="text-left py-1 px-2 font-semibold">Metric</th>
                <th className="text-left py-1 px-1 font-semibold">Family</th>
                <th className="text-right py-1 px-1 font-semibold" title="Relative weight inside family">
                  Wgt
                </th>
                <th className="text-center py-1 px-1 font-semibold">Better</th>
                <th className="text-left py-1 px-2 font-semibold">Notes</th>
              </tr>
            </thead>
            <tbody>
              {ENGINE_METRICS.map((m) => (
                <tr key={m.key} id={`metric-${m.key}`} className="border-b border-zinc-800/80 text-amber-200/70">
                  <td className="py-1 px-2 text-white/90">{m.label}</td>
                  <td className="py-1 px-1 capitalize text-amber-200/50">{m.family}</td>
                  <td className="py-1 px-1 text-right font-mono tabular-nums text-sky-300/80">{m.baseIntra}</td>
                  <td className="py-1 px-1 text-center">{m.higherIsBetter ? "↑" : "↓"}</td>
                  <td className="py-1 px-2 text-amber-200/55">{m.treatment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-[11px] font-semibold text-white mb-1.5">Still missing (free data)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] border-collapse min-w-[420px]">
            <thead>
              <tr className="border-b border-[#d4af37]/25 text-[#d4af37]/80">
                <th className="text-left py-1 pr-2 font-semibold">Want</th>
                <th className="text-left py-1 px-2 font-semibold">Status</th>
                <th className="text-left py-1 px-2 font-semibold">Stand-in</th>
              </tr>
            </thead>
            <tbody>
              {SPECIALTY_GAP_NOTES.map((g) => (
                <tr key={g.want} className="border-b border-zinc-800/80 text-amber-200/70">
                  <td className="py-1 pr-2 text-white/90">{g.want}</td>
                  <td className="py-1 px-2">{g.status}</td>
                  <td className="py-1 px-2 text-amber-200/55">{g.interim}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
