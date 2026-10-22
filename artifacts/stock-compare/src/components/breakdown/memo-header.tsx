// "Memo header" of StockBreakdown: our fund model chips + trade overlay + bull/bear cases.
import { BullBearCases } from "../market-sentiment-section";
import { ScoreBadge } from "../breakdown-metrics-table";
import { PillarChip, type BreakdownData } from "./stock-breakdown-parts";
import { freshnessBand } from "@/lib/provenance-display";
import { formatMdYy } from "@/lib/format";
import { useBreakdownMeta } from "./breakdown-meta-context";
import { DataTip } from "../data-tip";

function shortAge(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return null;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return formatMdYy(iso);
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
  const scoredLabel = shortAge(se?.scoredAt);
  const inputsLabel = shortAge(se?.inputsAsOf);
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
      <div id="bd-memo-header" className="mt-0.5 space-y-1.5">
        <div className="bg-zinc-950 border border-[#d4af37]/25 rounded-lg px-2.5 py-2 space-y-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#d4af37]">ETF</span>
            {etf.family ? <span className="text-[11px] text-amber-100/80">{etf.family}</span> : null}
            {etf.category ? (
              <span className="text-[10px] font-semibold italic px-1.5 py-0.5 rounded border border-violet-400/60 text-violet-200 bg-violet-500/20">
                {etf.category}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-mono tabular-nums text-white">
            <span>Yield <b className="text-[#d4af37]">{etf.yield != null ? `${(etf.yield * 100).toFixed(2)}%` : "—"}</b></span>
            <span>AUM <b>{aum}</b></span>
            <span>YTD <b className={etf.ytdReturn != null && etf.ytdReturn >= 0 ? "text-green-400" : "text-red-400"}>
              {etf.ytdReturn != null ? `${(etf.ytdReturn * 100).toFixed(1)}%` : "—"}
            </b></span>
            <span>P/E <b>{etf.trailingPe != null ? etf.trailingPe.toFixed(1) : "—"}</b></span>
          </div>
          {etf.holdings.length > 0 ? (
            <p className="text-[10px] text-amber-200/50 truncate">
              Top: {etf.holdings.slice(0, 8).map((h) => h.symbol).join(" · ")}
            </p>
          ) : null}
          <p className="text-[10px] text-amber-200/40 italic">
            Stock fund model / peer scores N/A for ETFs — price chart + yield/AUM above.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div id="bd-memo-header" className="mt-0.5 space-y-1.5">
      {/* Our peer-relative fund model — not the Street (WRDS/LSEG) panel below */}
      <div className="bg-zinc-950 border border-[#d4af37]/25 rounded-lg px-2.5 py-2 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <DataTip tip="Peer-relative fundamentals — separate from Street (WRDS/LSEG) below">
            <span className="text-[10px] font-bold uppercase tracking-wider text-[#d4af37]">
              Our Fund
            </span>
          </DataTip>
          <span className="text-base leading-none">
            <ScoreBadge
              score={se?.modelScore ?? se?.total}
              max={100}
              tip={meta?.tipFundPillar("Tot")}
            />
          </span>
          {se?.activeAdjPoints ? (
            <DataTip tip={meta?.tipFundPillar("Desk")}>
              <span className="text-[11px] font-mono text-amber-200">
                <span className="font-semibold">Desk</span>{" "}
                <span className="font-bold">{se.deskScore != null ? se.deskScore.toFixed(0) : "—"}</span>
                <span className="text-amber-100/80 ml-1 italic">
                  (adj {se.activeAdjPoints >= 0 ? "+" : ""}{se.activeAdjPoints})
                </span>
              </span>
            </DataTip>
          ) : null}
          <PillarChip label="V" score={se?.value} title={meta?.tipFundPillar("V") ?? "Value pillar"} />
          <PillarChip label="G" score={se?.growth} title={meta?.tipFundPillar("G") ?? "Growth pillar"} />
          <PillarChip label="Q" score={se?.quality} title={meta?.tipFundPillar("Q") ?? "Quality pillar"} />
          <PillarChip label="S" score={se?.safety} title={meta?.tipFundPillar("S") ?? "Safety pillar"} />
          {se?.style && (
            <DataTip tip="Style bucket from fund scorer (computed)">
              <span className="text-[10px] font-semibold italic px-1.5 py-0.5 rounded border border-violet-400/60 text-violet-200 bg-violet-500/20">
                {se.style}
              </span>
            </DataTip>
          )}
          {se?.confidence && (
            <DataTip tip="Fund-score confidence from input coverage (computed)">
              <span className="text-[10px] font-semibold text-sky-200 underline decoration-sky-500/50 underline-offset-2">
                {se.confidence} conf
              </span>
            </DataTip>
          )}
          {inputsStale && (
            <DataTip tip="Fundamentals inputs older than 30d — score may lag; not excluded from rankings yet (needs Jamie)">
              <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border border-orange-400/60 text-orange-200 bg-orange-500/20">
                STALE inputs
              </span>
            </DataTip>
          )}
        </div>
        {(scoredLabel || inputsLabel) && (
          <DataTip
            tip={[
              se?.scoredAt ? `fund_score_computed_at ${se.scoredAt}` : null,
              se?.inputsAsOf ? `fundamentals_last_fetched ${se.inputsAsOf}` : null,
            ].filter(Boolean).join(" · ")}
          >
            <p className="text-[9px] text-amber-100/50 font-mono">
              {scoredLabel ? <>computed {scoredLabel}</> : null}
              {scoredLabel && inputsLabel ? " · " : null}
              {inputsLabel ? <>inputs as of {inputsLabel}</> : null}
            </p>
          </DataTip>
        )}
        <div className="flex flex-wrap items-center gap-1.5 border-t border-[#d4af37]/15 pt-1.5">
          <span className="text-[9px] font-bold uppercase tracking-wider text-sky-300">Trade</span>
          {tr?.techScore != null && (
            <PillarChip label="Tech" score={tr.techScore} title={meta?.tipTrade("tech") ?? "Technical score"} />
          )}
          {tr?.ivVsRealized != null && (
            <DataTip tip={meta?.tipTrade("ivRv")}>
              <span className="text-[11px] font-mono font-bold tabular-nums text-white px-1.5 py-0.5 rounded border border-sky-400/50 bg-sky-500/15">
                IV/RV {tr.ivVsRealized.toFixed(2)}
              </span>
            </DataTip>
          )}
          {tr?.atmPutIv != null && (
            <DataTip tip={meta?.tipTrade("iv")}>
              <span className="text-[11px] font-mono font-bold tabular-nums text-white px-1.5 py-0.5 rounded border border-cyan-400/50 bg-cyan-500/15">
                IV {tr.atmPutIv.toFixed(0)}%
              </span>
            </DataTip>
          )}
          {(tr?.earningsDaysOut != null || earns) && (
            <DataTip tip={meta?.tipTrade("er") ?? "Next earnings"}>
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border bg-yellow-500/25 text-yellow-200 border-yellow-400/60">
                {tr?.earningsDaysOut != null ? `ER ${tr.earningsDaysOut}d` : earns}
              </span>
            </DataTip>
          )}
          {tr?.streetEventRisk && (
            <DataTip tip="Street event risk — large |breadth| or |SUE| (WRDS/IBES derived)">
              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded border border-red-400/70 text-red-200 bg-red-500/20">
                Event risk
              </span>
            </DataTip>
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
            metrics={data.metrics}
          />
        </div>
      )}
    </div>
  );
}
