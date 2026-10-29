// "Memo header" of StockBreakdown: total score + trade chips + bull/bear cases.
import { BullBearCases } from "../market-sentiment-section";
import { PillarChip, type BreakdownData } from "./stock-breakdown-parts";
import { freshnessBand } from "@/lib/provenance-display";
import { formatMdYy } from "@/lib/format";
import { useBreakdownMeta } from "./breakdown-meta-context";
import { DataTip } from "../data-tip";
import { cn } from "@/lib/utils";

/** Oval trade chip — label over value (same size/shape as PillarChip). */
function TradeChip({
  tip,
  className,
  label,
  value,
}: {
  tip?: string;
  className: string;
  label: string;
  value: string;
}) {
  const chip = (
    <span
      className={cn(
        "inline-flex flex-col items-center justify-center px-2 py-0.5 rounded-full border shrink-0",
        "text-[8px] font-semibold uppercase tracking-wide leading-none",
        className,
      )}
    >
      <span className="font-sans">{label}</span>
      <span className="font-mono tabular-nums text-[10px] font-bold leading-none mt-0.5 normal-case tracking-normal">
        {value}
      </span>
    </span>
  );
  return tip ? <DataTip tip={tip}>{chip}</DataTip> : chip;
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
  const stampIso = se?.scoredAt ?? se?.inputsAsOf ?? null;
  const stamp = stampIso ? formatMdYy(stampIso) : null;
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
      {/* No box border — oval pills like Industrials tags; TOTAL larger, rest uniform. */}
      <div className="flex flex-nowrap items-center gap-x-1 min-w-0 overflow-x-auto py-0.5">
        <DataTip tip="Peer-relative fund score (not Street)">
          <span className="inline-flex flex-col items-center justify-center px-2.5 py-1 rounded-full border border-[#d4af37] bg-[#d4af37] text-black shrink-0 leading-none">
            <span className="text-[9px] font-bold uppercase tracking-wide font-sans">Total</span>
            <span className="font-mono tabular-nums text-[13px] font-bold leading-none mt-0.5">{total}</span>
          </span>
        </DataTip>
        {se?.activeAdjPoints ? (
          <DataTip tip={meta?.tipFundPillar("Desk")}>
            <span className="inline-flex flex-col items-center justify-center px-2 py-0.5 rounded-full border border-amber-400/60 text-amber-300 shrink-0 leading-none">
              <span className="text-[8px] font-semibold uppercase tracking-wide">Desk</span>
              <span className="font-mono tabular-nums text-[10px] font-bold leading-none mt-0.5">
                {se.deskScore != null ? se.deskScore.toFixed(0) : "—"}
                <span className="ml-0.5">({se.activeAdjPoints >= 0 ? "+" : ""}{se.activeAdjPoints})</span>
              </span>
            </span>
          </DataTip>
        ) : null}
        <PillarChip label="Value" score={se?.value} title={meta?.tipFundPillar("V") ?? "Value pillar"} />
        <PillarChip label="Growth" score={se?.growth} title={meta?.tipFundPillar("G") ?? "Growth pillar"} />
        <PillarChip label="Quality" score={se?.quality} title={meta?.tipFundPillar("Q") ?? "Quality pillar"} />
        <PillarChip label="Safety" score={se?.safety} title={meta?.tipFundPillar("S") ?? "Safety pillar"} />
        {inputsStale && (
          <DataTip tip="Inputs >30d old">
            <span className="text-[8px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full border border-orange-500 bg-orange-500 text-black shrink-0">
              STALE
            </span>
          </DataTip>
        )}

        {tr?.techScore != null && (
          <PillarChip label="Tech" score={tr.techScore} title="Technical score" />
        )}
        {tr?.ivVsRealized != null && (
          <TradeChip tip="ATM put IV ÷ 20d realized vol" className="border-sky-500 bg-sky-500 text-black"
            label="IV/RV" value={tr.ivVsRealized.toFixed(2)} />
        )}
        {tr?.atmPutIv != null && (
          <TradeChip tip="ATM put implied vol" className="border-cyan-400 bg-cyan-400 text-black"
            label="IV" value={`${tr.atmPutIv.toFixed(0)}%`} />
        )}
        {(tr?.earningsDaysOut != null || earns) && (
          <TradeChip tip="Days to next earnings" className="border-amber-400 bg-amber-400 text-black"
            label="ER" value={tr?.earningsDaysOut != null ? `${tr.earningsDaysOut}d` : String(earns)} />
        )}
        {tr?.streetEventRisk && (
          <TradeChip tip="Street event risk (breadth / SUE)" className="border-rose-500 bg-rose-500 text-white"
            label="Event" value="risk" />
        )}
        {!tr?.techScore && tr?.ivVsRealized == null && tr?.atmPutIv == null && !tr?.earningsDaysOut && !earns && !tr?.streetEventRisk && (
          <span className="text-[10px] text-white italic shrink-0">No trade overlay</span>
        )}

        {stamp && (
          <DataTip tip={["Score as-of", se?.style ? `· ${se.style}` : null, se?.confidence ? `· ${se.confidence} conf` : null].filter(Boolean).join(" ")}>
            <span className="ml-auto text-[12px] font-mono font-semibold tabular-nums text-white shrink-0 cursor-help">
              {stamp}
            </span>
          </DataTip>
        )}
      </div>
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
