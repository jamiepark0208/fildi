/**
 * A190 — House view card (stance + index odds + coherence warnings).
 */
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pct01, useHouseView } from "@/hooks/use-house-view";

export function HouseViewWarnings({ className }: { className?: string }) {
  const { data } = useHouseView();
  const warnings = data?.warnings ?? [];
  if (!warnings.length) return null;
  return (
    <ul className={className ?? "space-y-1"}>
      {warnings.map((w) => (
        <li key={w} className="flex gap-2 text-[12px] leading-snug text-red-300/90">
          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
          <span>{w}</span>
        </li>
      ))}
    </ul>
  );
}

export function HouseViewCard() {
  const { data, isLoading, error } = useHouseView();
  if (isLoading) {
    return <div className="text-[11px] text-amber-200/40 p-3">Loading house view…</div>;
  }
  if (error || !data) return null;

  const odds = data.payload?.odds;
  const up = odds?.up?.s057_logit;
  const upBase = odds?.up?.base_rate;
  const tail = odds?.tail?.s057_logit;
  const tailBase = odds?.tail?.base_rate;
  const market = odds?.tail?.market_vix;

  return (
    <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#d4af37]">House view</span>
        <span className="text-[10px] text-amber-200/40 font-mono">{data.viewDate}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="text-amber-200/40 hover:text-amber-200/80">
              <Info className="w-3 h-3" />
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="left"
            className="max-w-[340px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug"
          >
            <div className="font-semibold">S057 / S058 index odds</div>
            <div>
              SPY next 21 trading days. P(up) and P(another −5% leg) from the S057 logit; base rates are history;
              market = risk-neutral barrier from VIX (often rich). Graded in the forecast ledger (Brier).
            </div>
            <div className="mt-1 text-amber-200/60">Display only — not a new score.</div>
          </TooltipContent>
        </Tooltip>
      </div>

      {data.warnings.length > 0 && <HouseViewWarnings />}

      <p className="text-[12px] leading-snug text-amber-100/90">
        {data.stance ?? "Stance unavailable — see memo."}
      </p>

      <div className="flex flex-wrap gap-3 text-[11px] font-mono tabular-nums text-sky-100/90">
        <span title="S057 P(up) vs base rate">
          P(up) {pct01(up)}
          <span className="text-zinc-500"> / base {pct01(upBase)}</span>
        </span>
        <span title="S057 P(−5% leg) vs base vs market VIX">
          P(−5%) {pct01(tail)}
          <span className="text-zinc-500">
            {" "}
            / base {pct01(tailBase)} / mkt {pct01(market)}
          </span>
        </span>
        {odds?.vix != null && (
          <span className="text-zinc-500">VIX {odds.vix.toFixed(1)}</span>
        )}
      </div>
    </div>
  );
}
