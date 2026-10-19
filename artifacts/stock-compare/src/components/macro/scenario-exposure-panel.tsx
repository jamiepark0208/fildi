/**
 * A149 — Macro › Scenario: OpenJev S039 business-description match vs factor scenarios.
 * Score is −1…+1 qualitative fit — NOT estimated % crash (betas deferred).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

type Side = { ticker: string; peerGroup: string; score: number };
type Resp = {
  available: boolean;
  scenario: string;
  label: string;
  note: string;
  hurt: Side[];
  helped: Side[];
  covered: number;
  universe: number;
  scenarios: { id: string; label: string }[];
};

/** Map −1…+1 fit → short label (never pretend this is % move). */
function fitLabel(score: number): { text: string; bar: number; tone: string } {
  const bar = Math.min(100, Math.round(Math.abs(score) * 100));
  if (score <= -0.7) return { text: "High", bar, tone: "text-red-400" };
  if (score <= -0.25) return { text: "Med", bar, tone: "text-orange-400" };
  if (score < 0.25) return { text: "Low", bar, tone: "text-amber-200/80" };
  if (score < 0.7) return { text: "Tail+", bar, tone: "text-emerald-400/90" };
  return { text: "Tail", bar, tone: "text-emerald-400" };
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
        <div className="text-[9px] text-amber-200/55 leading-snug">{hint}</div>
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-amber-200/50">No book names in cache</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => {
            const fit = fitLabel(r.score);
            const group = r.peerGroup.replace(/^[^.]+\./, "").replace(/_/g, " ");
            return (
              <li
                key={r.ticker}
                className="grid grid-cols-[3.5rem_2.25rem_1fr_3.5rem] items-center gap-x-1.5 h-[22px] text-[11px] font-mono"
                title={`OpenJev fit ${r.score.toFixed(2)} (−1…+1). Not a predicted % move. ${group}`}
              >
                <span className="font-bold text-white truncate">{r.ticker}</span>
                <span className={cn("text-right font-semibold tabular-nums", fit.tone)}>{fit.text}</span>
                <span className="h-1 rounded-sm bg-zinc-800 overflow-hidden min-w-0">
                  <span
                    className={cn("block h-full rounded-sm", r.score < 0 ? "bg-red-500/80" : "bg-emerald-500/70")}
                    style={{ width: `${fit.bar}%` }}
                  />
                </span>
                <span className="truncate text-[9px] text-amber-200/50" title={group}>{group}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ScenarioExposurePanel() {
  const [scenario, setScenario] = useState("credit");
  const { data, isLoading } = useQuery({
    queryKey: ["live-scenarios", scenario],
    queryFn: async (): Promise<Resp> => {
      const r = await fetch(`/api/live/scenarios?scenario=${encodeURIComponent(scenario)}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 10 * 60_000,
  });

  const tabs = data?.scenarios ?? [
    { id: "oil", label: "Oil spikes" },
    { id: "rates", label: "Rates up" },
    { id: "ai", label: "AI spend" },
  ];

  return (
    <div className="rounded-md border border-[#d4af37]/20 bg-zinc-950 overflow-hidden">
      <div className="px-2.5 py-1.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-[#d4af37]/15">
        <span className="text-[11px] font-bold tracking-tight text-[#d4af37]">Scenario</span>
        <span className="text-[10px] text-amber-200/60 tabular-nums">
          {data ? `${data.covered}/${data.universe} book scored` : "…"}
        </span>
        <span className="text-[9px] text-amber-200/50 leading-snug w-full sm:w-auto sm:ml-auto">
          Business-description match (−1…+1) — not crash %. Realized betas not baked yet.
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
                : "border-[#d4af37]/25 text-amber-200/70 hover:text-[#d4af37] hover:border-[#d4af37]/40",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="px-2.5 py-2">
        {isLoading && <p className="text-[11px] text-amber-200/50">Loading…</p>}
        {!isLoading && data && !data.available && (
          <p className="text-[11px] text-amber-200/70">
            No scenarios cache — run <span className="font-mono text-[#d4af37]">openjev_controls.py --scenarios</span> on this Mac.
          </p>
        )}
        {!isLoading && data?.available && (
          <div className="flex flex-col sm:flex-row gap-3 sm:gap-4">
            <Col
              title="Most exposed"
              hint={`If “${data.label}” hits — book names whose business fits the downside`}
              rows={data.hurt}
            />
            <Col
              title="Least exposed"
              hint={`Same scenario — names least matched to the downside (or slight tailwind)`}
              rows={data.helped}
            />
          </div>
        )}
      </div>
    </div>
  );
}
