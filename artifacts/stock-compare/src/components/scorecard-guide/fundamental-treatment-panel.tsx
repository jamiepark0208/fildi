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

/** Scorecard Guide — live engine catalog (replaces stale PUT_SELLER / FactSet→FMP grid). */
export function FundamentalTreatmentPanel() {
  return (
    <div className="space-y-3 rounded-md border border-[#d4af37]/25 bg-zinc-950/80 p-3">
      <div>
        <h2 className="text-xs font-semibold text-[#d4af37]/90 uppercase tracking-wide">
          Persisted fundamental score (engine SoT)
        </h2>
        <p className="text-[11px] text-amber-200/50 mt-1 leading-relaxed">
          Home / rankings / scanner read <span className="text-amber-200/70">fund_*_score</span> from
          DB. Weights below are from <span className="font-mono text-[10px]">fund-score-engine</span> —
          not the legacy editable PUT_SELLER preset (that only affects client experiments).
        </p>
      </div>

      <div className="rounded border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2 text-[11px] text-emerald-200/80">
        Cross-section: <span className="font-mono">{CROSS_SECTION_BLEND.peer * 100}% peer</span> +{" "}
        <span className="font-mono">{CROSS_SECTION_BLEND.sector * 100}% sector</span>.{" "}
        {CROSS_SECTION_BLEND.note}
      </div>

      <ol className="space-y-1 list-decimal list-inside text-[11px] text-amber-200/70">
        {SCORE_PIPELINE_STEPS.map((s) => (
          <li key={s} className="leading-snug">{s}</li>
        ))}
      </ol>

      <div>
        <h3 className="text-[11px] font-semibold text-white mb-1.5">Characteristic decision flow</h3>
        <div className="space-y-2">
          {TREATMENT_FLOW.map((step, i) => (
            <div key={step.id} className="rounded border border-[#d4af37]/15 bg-black/40 px-2.5 py-2">
              <div className="flex items-baseline gap-2">
                <span className="text-[10px] font-mono text-[#d4af37]/70">{i + 1}</span>
                <span className="text-[11px] font-semibold text-white">{step.title}</span>
              </div>
              <p className="text-[10px] text-amber-200/45 mt-0.5">
                <span className="text-amber-200/60">If </span>
                {step.detector}
              </p>
              <p className="text-[10px] text-emerald-400/80 mt-0.5">{step.action}</p>
              <ul className="mt-1 space-y-0.5">
                {step.metricEffects.map((e) => (
                  <li key={e} className="text-[10px] text-amber-200/55 pl-2 border-l border-[#d4af37]/20">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-[11px] font-semibold text-white mb-1.5">
          Family weights by style (% of total) — live engine
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
          Metrics scored ({ENGINE_METRICS.length}) — base intra-weight × style/mode tilts
        </h3>
        <div className="overflow-x-auto max-h-80 overflow-y-auto rounded border border-[#d4af37]/15">
          <table className="w-full text-[10px] border-collapse min-w-[640px]">
            <thead className="sticky top-0 bg-black text-[#d4af37]/80">
              <tr className="border-b border-[#d4af37]/25">
                <th className="text-left py-1 px-2 font-semibold">Metric</th>
                <th className="text-left py-1 px-1 font-semibold">Fam</th>
                <th className="text-right py-1 px-1 font-semibold">Intra</th>
                <th className="text-center py-1 px-1 font-semibold">Dir</th>
                <th className="text-left py-1 px-2 font-semibold">Gold inputs</th>
                <th className="text-left py-1 px-2 font-semibold">Treatment</th>
              </tr>
            </thead>
            <tbody>
              {ENGINE_METRICS.map((m) => (
                <tr key={m.key} id={`metric-${m.key}`} className="border-b border-zinc-800/80 text-amber-200/70">
                  <td className="py-1 px-2 text-white/90">{m.label}</td>
                  <td className="py-1 px-1 capitalize text-amber-200/50">{m.family.slice(0, 3)}</td>
                  <td className="py-1 px-1 text-right font-mono tabular-nums text-sky-300/80">{m.baseIntra}</td>
                  <td className="py-1 px-1 text-center">{m.higherIsBetter ? "↑" : "↓"}</td>
                  <td className="py-1 px-2 font-mono text-[9px] text-amber-200/45">{m.goldInputs}</td>
                  <td className="py-1 px-2 text-amber-200/55">{m.treatment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-amber-200/40 mt-1.5">
          Missing/excluded metrics drop weight (not scored as 0). Intra tilts multiply baseIntra by style/mode.
        </p>
      </div>

      <div>
        <h3 className="text-[11px] font-semibold text-white mb-1.5">Specialty gaps (free APIs)</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-[10px] border-collapse min-w-[480px]">
            <thead>
              <tr className="border-b border-[#d4af37]/25 text-[#d4af37]/80">
                <th className="text-left py-1 pr-2 font-semibold">Want</th>
                <th className="text-left py-1 px-2 font-semibold">Free API status</th>
                <th className="text-left py-1 px-2 font-semibold">Interim</th>
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
        <p className="text-[10px] text-amber-200/40 mt-1">
          Full inventories: <span className="font-mono">.agents/context/data-source-fields/</span>
        </p>
      </div>
    </div>
  );
}
