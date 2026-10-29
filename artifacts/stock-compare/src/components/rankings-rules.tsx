/**
 * Rankings › Rules (Jamie 10-24: one rules engine — same inputs for every strategy, direction flips:
 * sell options → richest, buy options → cheapest; bullish → strong names, bearish → weak).
 * Reads /api/rankings/rules (scripts/watchlist_sync/strategy_rules.json, the one home). Evidence in the hover.
 */
import { useQuery } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PutBandSelector } from "@/components/put-band-selector";

type Cell = { want: "high" | "low" | "none"; verdict: string; live: string; evidence: string };
type Rules = {
  version: string; updated: string; principle: string;
  strategies: { id: string; label: string; view: string; premium: string; where: string }[];
  inputs: { id: string; label: string; source: string; ui: string; cells: Record<string, Cell> }[];
  pairs?: Record<string, string>;
};

const VERDICT_TONE: Record<string, string> = {
  works: "bg-zinc-900 text-white border-emerald-400/70",
  fails: "bg-zinc-900 text-white border-rose-400/70",
  "too early": "bg-zinc-900 text-white border-amber-400/70",
  candidate: "bg-zinc-900 text-white border-sky-400/70",
  mixed: "bg-zinc-900 text-white border-amber-400/50",
  redundant: "bg-zinc-900 text-zinc-300 border-zinc-600",
  untested: "bg-zinc-900 text-amber-100 border-zinc-700",
};
const WANT = { high: "↑ high", low: "↓ low", none: "—" } as const;

function Tip({ children, body }: { children: React.ReactNode; body: React.ReactNode }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[340px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
        {body}
      </TooltipContent>
    </Tooltip>
  );
}

export function RankingsRules() {
  const { data, isLoading } = useQuery({
    queryKey: ["rankings-rules"],
    queryFn: async () => {
      const r = await fetch("/api/rankings/rules");
      if (!r.ok) throw new Error("rules failed");
      return (await r.json()) as { rules: Rules | null };
    },
    staleTime: 5 * 60_000,
  });
  if (isLoading) return <p className="text-sm text-amber-100 animate-pulse">Loading rules…</p>;
  const R = data?.rules;
  if (!R) return <p className="text-sm text-amber-100">No rules file yet.</p>;
  return (
    <div className="space-y-2 min-w-0">
      <PutBandSelector className="max-w-[900px]" />
      <p className="text-[11px] text-amber-200/60 max-w-[900px]">
        {R.principle} <span className="text-amber-100/80">· {R.version} · {R.updated}</span>
      </p>
      <div className="overflow-x-auto">
        <table className="text-[11px] border-collapse min-w-[760px]">
          <thead>
            <tr className="text-amber-200/50">
              <th className="text-left font-semibold px-2 py-1 w-[220px]">Input</th>
              {R.strategies.map((s) => (
                <th key={s.id} className="text-left font-semibold px-2 py-1">
                  <Tip body={<>{s.view} · {s.premium === "sell" ? "sells premium → wants rich options" : "buys premium → wants cheap options"}<br />{s.where}</>}>
                    <span className="cursor-help">{s.label}</span>
                  </Tip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {R.inputs.map((i) => (
              <tr key={i.id} className="border-t border-zinc-800 align-top">
                <td className="px-2 py-1.5">
                  <Tip body={<>Source: {i.source}<br />Shown: {i.ui}</>}>
                    <span className="text-zinc-200 cursor-help">{i.label}</span>
                  </Tip>
                </td>
                {R.strategies.map((s) => {
                  const c = i.cells[s.id];
                  if (!c) return <td key={s.id} className="px-2 py-1.5 text-zinc-600">—</td>;
                  return (
                    <td key={s.id} className="px-2 py-1.5">
                      <Tip body={<>{c.evidence}{c.live !== "—" && <><br /><span className="text-amber-200/70">Live: {c.live}</span></>}</>}>
                        <div className="flex items-center gap-1.5 cursor-help">
                          <span className="text-zinc-300 w-[44px] shrink-0">{WANT[c.want]}</span>
                          <span className={cn("px-1.5 py-px rounded border", VERDICT_TONE[c.verdict] ?? VERDICT_TONE.untested)}>{c.verdict}</span>
                          {c.live !== "—" && <span className="text-[#d4af37]" title="live in a score">●</span>}
                        </div>
                      </Tip>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {R.pairs && (
        <div className="text-[11px] text-zinc-300 space-y-0.5 max-w-[900px]">
          <div className="text-amber-200/60">Two inputs together · {R.pairs.study}</div>
          {R.strategies.map((s) => R.pairs?.[s.id] && (
            <div key={s.id}><span className="text-amber-100">{s.label}:</span> {R.pairs[s.id]}</div>
          ))}
        </div>
      )}
      <p className="text-[10px] text-amber-100/80">● = live in a score or board today · hover a cell for the study and where it is used · untested cells are the study queue</p>
    </div>
  );
}
