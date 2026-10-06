// "Memo header" of StockBreakdown: our fund model chips + trade overlay + bull/bear cases.
import { BullBearCases } from "../market-sentiment-section";
import { ScoreBadge } from "../breakdown-metrics-table";
import { PillarChip, type BreakdownData } from "./stock-breakdown-parts";

export function MemoHeader({ data }: { data: BreakdownData }) {
  const se = data.scoreEvidence;
  const tr = data.tradeOverlay;
  const catalysts = data.catalysts ?? [];
  const earns = catalysts.find((l) => /^(Earnings|Next earnings)/i.test(l));
  const hasCases =
    catalysts.some((l) => !/^(Earnings|Next earnings)/i.test(l)) ||
    (data.bullBullets?.length ?? 0) > 0 ||
    (data.bearBullets?.length ?? 0) > 0;
  return (
    <div id="bd-memo-header" className="mt-0.5 space-y-1.5">
      {/* Our peer-relative fund model — not the Street (WRDS/LSEG) panel below */}
      <div className="bg-zinc-950 border border-[#d4af37]/25 rounded-lg px-2.5 py-2 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#d4af37]" title="Peer-relative fundamentals — separate from Street (WRDS/LSEG) below">
            Our Fund
          </span>
          <span className="text-base leading-none" title="Peer-relative fundamental score (0–100)">
            <ScoreBadge score={se?.modelScore ?? se?.total} max={100} />
          </span>
          {se?.activeAdjPoints ? (
            <span className="text-[11px] font-mono text-amber-200" title="model + active desk adj">
              <span className="font-semibold">Desk</span>{" "}
              <span className="font-bold">{se.deskScore != null ? se.deskScore.toFixed(0) : "—"}</span>
              <span className="text-amber-100/80 ml-1 italic">
                (adj {se.activeAdjPoints >= 0 ? "+" : ""}{se.activeAdjPoints})
              </span>
            </span>
          ) : null}
          <PillarChip label="V" score={se?.value} title="Value pillar" />
          <PillarChip label="G" score={se?.growth} title="Growth pillar" />
          <PillarChip label="Q" score={se?.quality} title="Quality pillar" />
          <PillarChip label="S" score={se?.safety} title="Safety pillar" />
          {se?.style && (
            <span className="text-[10px] font-semibold italic px-1.5 py-0.5 rounded border border-violet-400/60 text-violet-200 bg-violet-500/20">
              {se.style}
            </span>
          )}
          {se?.confidence && (
            <span className="text-[10px] font-semibold text-sky-200 underline decoration-sky-500/50 underline-offset-2">
              {se.confidence} conf
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[#d4af37]/15 pt-1.5">
          <span className="text-[9px] font-bold uppercase tracking-wider text-sky-300">Trade</span>
          {tr?.techScore != null && (
            <PillarChip label="Tech" score={tr.techScore} title="Technical score" />
          )}
          {tr?.ivVsRealized != null && (
            <span className="text-[11px] font-mono font-bold tabular-nums text-white px-1.5 py-0.5 rounded border border-sky-400/50 bg-sky-500/15">
              IV/RV {tr.ivVsRealized.toFixed(2)}
            </span>
          )}
          {tr?.atmPutIv != null && (
            <span className="text-[11px] font-mono font-bold tabular-nums text-white px-1.5 py-0.5 rounded border border-cyan-400/50 bg-cyan-500/15">
              IV {tr.atmPutIv.toFixed(0)}%
            </span>
          )}
          {(tr?.earningsDaysOut != null || earns) && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-yellow-500/25 text-yellow-200 border-yellow-400/60">
              {tr?.earningsDaysOut != null ? `ER ${tr.earningsDaysOut}d` : earns}
            </span>
          )}
          {tr?.streetEventRisk && (
            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-red-400/70 text-red-200 bg-red-500/20">
              Event risk
            </span>
          )}
          {!tr?.techScore && tr?.ivVsRealized == null && tr?.atmPutIv == null && !tr?.earningsDaysOut && !earns && !tr?.streetEventRisk && (
            <span className="text-[10px] text-amber-100/70 italic">No trade overlay yet</span>
          )}
        </div>
      </div>
      {hasCases && (
        <div id="bd-cases">
          <BullBearCases
            bullBullets={data.bullBullets ?? []}
            bearBullets={data.bearBullets ?? []}
            catalysts={catalysts}
          />
        </div>
      )}
    </div>
  );
}
