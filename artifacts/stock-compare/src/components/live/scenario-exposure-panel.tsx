/**
 * A149 — Live › Macro scenario exposure (OpenJev S039). Display only.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
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

function scoreTone(s: number) {
  if (s <= -0.4) return "text-red-300";
  if (s >= 0.4) return "text-emerald-300";
  return "text-amber-200/70";
}

function Col({ title, rows, hurt }: { title: string; rows: Side[]; hurt: boolean }) {
  return (
    <div className="min-w-0 flex-1">
      <div className={cn("text-[10px] uppercase tracking-wide mb-1", hurt ? "text-red-300/80" : "text-emerald-300/80")}>
        {title}
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-white/40">No book names in this cache</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li key={r.ticker} className="flex items-baseline gap-2 text-[12px] font-mono tabular-nums">
              <span className="w-12 font-semibold text-amber-100">{r.ticker}</span>
              <span className={cn("w-14 text-right", scoreTone(r.score))}>
                {r.score >= 0 ? "+" : ""}{r.score.toFixed(2)}
              </span>
              <span className="truncate text-[10px] text-white/35" title={r.peerGroup}>
                {r.peerGroup.replace(/^[^.]+\./, "")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ScenarioExposurePanel() {
  const [scenario, setScenario] = useState("oil");
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
    <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 overflow-hidden">
      <div className="px-2.5 py-1.5 flex items-center gap-2 border-b border-[#d4af37]/15">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[#d4af37]">Scenario exposure</span>
        <span className="text-[10px] text-white/45">
          {data ? `${data.covered}/${data.universe} book` : "…"}
        </span>
        <Tooltip delayDuration={150}>
          <TooltipTrigger asChild>
            <button type="button" className="ml-auto text-white/40 hover:text-white"><Info className="w-3.5 h-3.5" /></button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-[320px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
            {data?.note ?? "OpenJev read of business description vs factor scenarios (S039). Not a forecast."}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="px-2 py-1.5 flex flex-wrap gap-1 border-b border-[#d4af37]/10">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setScenario(t.id)}
            className={cn(
              "px-1.5 py-0.5 rounded text-[10px] border",
              scenario === t.id
                ? "bg-[#d4af37]/20 border-[#d4af37]/50 text-[#d4af37]"
                : "border-white/10 text-white/55 hover:border-[#d4af37]/30",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="px-2.5 py-2">
        {isLoading && <p className="text-[11px] text-white/40">Loading…</p>}
        {!isLoading && data && !data.available && (
          <p className="text-[11px] text-amber-200/60">
            No scenarios cache yet — run <span className="font-mono">openjev_controls.py --scenarios</span> on this Mac.
          </p>
        )}
        {!isLoading && data?.available && (
          <div className="flex gap-4">
            <Col title="Hurt if…" rows={data.hurt} hurt />
            <Col title="Helped if…" rows={data.helped} hurt={false} />
          </div>
        )}
      </div>
    </div>
  );
}
