// "Memo header" of StockBreakdown: total score + trade chips + bull/bear cases.
import { BullBearCases } from "../market-sentiment-section";
import { scoreInk, type BreakdownData } from "./stock-breakdown-parts";
import { freshnessBand } from "@/lib/provenance-display";
import { useBreakdownMeta } from "./breakdown-meta-context";
import { DataTip } from "../data-tip";
import { cn } from "@/lib/utils";

/** Oval trade chip — label over value (same size/shape as PillarChip). */
function TradeChip({
  tip,
  ink,
  label,
  value,
}: {
  tip?: string;
  ink: string;
  label: string;
  value: string;
}) {
  const chip = (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-white/20 bg-zinc-950 shrink-0 whitespace-nowrap leading-none">
      <span className="text-[9px] font-bold uppercase tracking-wide font-sans text-white">{label}</span>
      <span className={cn("font-mono tabular-nums text-[12px] font-bold leading-none normal-case tracking-normal", ink)}>
        {value}
      </span>
    </span>
  );
  return tip ? <DataTip tip={tip}>{chip}</DataTip> : chip;
}

function ivRvInk(v: number): string {
  if (v >= 1.15) return "text-emerald-400";
  if (v >= 0.85) return "text-amber-300";
  return "text-rose-400";
}

function ivInk(v: number): string {
  if (v >= 50) return "text-emerald-400";
  if (v >= 30) return "text-amber-300";
  return "text-rose-400";
}

function erInk(days: number): string {
  if (days <= 7) return "text-rose-400";
  if (days <= 21) return "text-amber-300";
  return "text-emerald-400";
}

export function MemoHeader({ data }: { data: BreakdownData }) {
  const meta = useBreakdownMeta();
  const se = data.scoreEvidence;
  const tr = data.tradeOverlay;
  const catalysts = data.catalysts ?? [];
  const earns = catalysts.find((l) => /^(Earnings|Next earnings)/i.test(l));
  const hasCases =
    catalysts.some((l) => !/^(Earnings|Next earnings)/i.test(l)) ||
    (data.bullBullets?.length ?? 0) > 0 ||
    (data.bearBullets?.length ?? 0) > 0;
  const inputsStale = freshnessBand(se?.inputsAsOf) === "stale";
  const etf = data.etfProfile;
  if (etf) {
    const aum = etf.totalAssets != null
      ? etf.totalAssets >= 1e12 ? `$${(etf.totalAssets / 1e12).toFixed(2)}T`
        : etf.totalAssets >= 1e9 ? `$${(etf.totalAssets / 1e9).toFixed(1)}B`
        : etf.totalAssets >= 1e6 ? `$${(etf.totalAssets / 1e6).toFixed(0)}M`
        : `$${etf.totalAssets.toFixed(0)}`
      : "—";
    return (
      <div id="bd-memo-header" className="mt-0.5 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-0.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#d4af37]">ETF</span>
          {etf.family ? <span className="text-[11px] text-white">{etf.family}</span> : null}
          {etf.category ? (
            <span className="text-[10px] font-bold italic px-2 py-0.5 rounded-full border border-violet-500 bg-violet-500 text-white">
              {etf.category}
            </span>
          ) : null}
          <span className="text-[11px] font-mono tabular-nums text-white">
            Yield <b className="text-[#d4af37]">{etf.yield != null ? `${(etf.yield * 100).toFixed(2)}%` : "—"}</b>
            {" · "}AUM <b>{aum}</b>
            {" · "}YTD{" "}
            <b className={etf.ytdReturn != null && etf.ytdReturn >= 0 ? "text-green-400" : "text-red-400"}>
              {etf.ytdReturn != null ? `${(etf.ytdReturn * 100).toFixed(1)}%` : "—"}
            </b>
          </span>
        </div>
      </div>
    );
  }
  const total = (se?.modelScore ?? se?.total) != null ? Math.round(se?.modelScore ?? se!.total!) : "—";
  return (
    <div id="bd-memo-header" className="mt-0.5 space-y-1">
      {/* Same oval size as Total. */}
      <div className="flex flex-nowrap items-center gap-1 overflow-x-auto py-0.5">
        <DataTip tip="Peer-relative fund score. Green ≥60, amber 40–59, red below.">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-white/20 bg-zinc-950 shrink-0 whitespace-nowrap leading-none">
            <span className="text-[9px] font-bold uppercase tracking-wide font-sans text-white">Total</span>
            <span className={cn("font-mono tabular-nums text-[12px] font-bold leading-none", scoreInk(typeof total === "number" ? total : null))}>{total}</span>
          </span>
        </DataTip>
        {se?.activeAdjPoints ? (
          <DataTip tip={meta?.tipFundPillar("Desk")}>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-white/20 bg-zinc-950 shrink-0 whitespace-nowrap leading-none">
              <span className="text-[9px] font-bold uppercase tracking-wide text-white">Desk</span>
              <span className={cn("font-mono tabular-nums text-[12px] font-bold leading-none", scoreInk(se.deskScore))}>
                {se.deskScore != null ? se.deskScore.toFixed(0) : "—"}
                <span className="ml-0.5">({se.activeAdjPoints >= 0 ? "+" : ""}{se.activeAdjPoints})</span>
              </span>
            </span>
          </DataTip>
        ) : null}
        {inputsStale && (
          <DataTip tip="Inputs >30d old">
            <span className="text-[8px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-orange-500 bg-orange-500 text-black shrink-0">
              STALE
            </span>
          </DataTip>
        )}

        {tr?.ivVsRealized != null && (
          <TradeChip tip="ATM put IV ÷ 20d realized vol. Green ≥1.15 (rich vs realized), amber near 1, red below 0.85. Not a sector rank."
            ink={ivRvInk(tr.ivVsRealized)} label="IV/RV" value={tr.ivVsRealized.toFixed(2)} />
        )}
        {tr?.atmPutIv != null && (
          <TradeChip tip="ATM put implied vol. Green ≥50%, amber 30–49%, red below. Not a sector rank."
            ink={ivInk(tr.atmPutIv)} label="IV" value={`${tr.atmPutIv.toFixed(0)}%`} />
        )}
        {(() => {
          const erValue = tr?.earningsDaysOut != null ? `${tr.earningsDaysOut}d` : earns ? String(earns) : null;
          const erTip = "Days to next earnings. Red within 7 days, amber through 21, green after.";
          if (tr?.streetEventRisk) {
            return (
              <TradeChip
                tip={erValue ? `${erTip} Next earnings ${erValue}. Street event risk is breadth / SUE.` : "Street event risk (breadth / SUE)."}
                ink="text-rose-400"
                label="Event"
                value="risk"
              />
            );
          }
          if (erValue) {
            return (
              <TradeChip tip={erTip}
                ink={tr?.earningsDaysOut != null ? erInk(tr.earningsDaysOut) : "text-amber-300"}
                label="ER" value={erValue} />
            );
          }
          return null;
        })()}
        {!tr?.techScore && tr?.ivVsRealized == null && tr?.atmPutIv == null && !tr?.earningsDaysOut && !earns && !tr?.streetEventRisk && (
          <span className="text-[10px] text-white italic shrink-0">No trade overlay</span>
        )}
      </div>
      {data.technicalsContext?.turningPoint?.line && (
        <DataTip tip="S151 turning-point model — timing tilt 1.3–1.8× vs base rate; context only, not a score input.">
          <div className="flex flex-wrap items-baseline gap-x-2 px-0.5 text-[10px] text-white leading-snug">
            <span className="text-[9px] font-bold uppercase tracking-wide text-[#d4af37] shrink-0">Turning point</span>
            <span className="font-mono tabular-nums">
              {data.technicalsContext.turningPoint.weekLow && (
                <>
                  wk-low {(data.technicalsContext.turningPoint.weekLow.prob * 100).toFixed(1)}% vs{" "}
                  {(data.technicalsContext.turningPoint.weekLow.base * 100).toFixed(1)}% · D
                  {data.technicalsContext.turningPoint.weekLow.decile}
                </>
              )}
              {data.technicalsContext.turningPoint.weekLow && data.technicalsContext.turningPoint.monthHigh && " · "}
              {data.technicalsContext.turningPoint.monthHigh && (
                <>
                  mo-high {(data.technicalsContext.turningPoint.monthHigh.prob * 100).toFixed(1)}% vs{" "}
                  {(data.technicalsContext.turningPoint.monthHigh.base * 100).toFixed(1)}% · D
                  {data.technicalsContext.turningPoint.monthHigh.decile}
                </>
              )}
            </span>
          </div>
        </DataTip>
      )}
      {hasCases && (
        <div id="bd-cases">
          <BullBearCases
            bullBullets={data.bullBullets ?? []}
            bearBullets={data.bearBullets ?? []}
            catalysts={catalysts}
            eventBulletsGeneratedAt={data.eventBulletsGeneratedAt}
            metricsAsOf={se?.inputsAsOf ?? se?.scoredAt ?? null}
          />
        </div>
      )}
    </div>
  );
}
