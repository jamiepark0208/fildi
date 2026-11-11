/**
 * Feed › Congress (A394) — latest Senate/House disclosures in our universe + most-bought names, 90 d. Display only, untested edge.
 * GET /api/congress/latest?days=30&universe=1 (stored FMP rows).
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { GRID_HEADER, GRID_TD, GRID_TH, GRID_WRAP, gridRow } from "@/lib/score-explain-format";
import { formatMdYy } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { CONGRESS_TIP, UntestedChip, typeCls, usd, type CongressRow, type CongressWindow, type Coverage } from "@/components/breakdown/congress-section";

type Latest = { rows: CongressRow[]; top: (CongressWindow & { symbol: string })[]; coverage: Coverage };

export function CongressFeedPanel({ className }: { className?: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ["congress", "latest"],
    queryFn: async (): Promise<Latest> => {
      const r = await fetch("/api/congress/latest?days=30&universe=1", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30 * 60_000,
  });
  return (
    <div className={cn("rounded-md border border-[#d4af37]/25 bg-zinc-950 p-3 space-y-2", className)}>
      <div className="flex items-center justify-between gap-2">
        <DataTip tip={CONGRESS_TIP}>
          <span className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Congress</span>
        </DataTip>
        <UntestedChip />
      </div>
      {isLoading ? (
        <div className="text-xs text-amber-100">Loading…</div>
      ) : !data || data.rows.length === 0 ? (
        <div className="text-xs text-amber-100">No disclosures for universe names in 30 d.</div>
      ) : (
        <>
          <div className="text-[9px] uppercase tracking-wide text-[#d4af37]">Most bought, 90 d (net $ midpoint)</div>
          <div className={GRID_WRAP}>
            <table className="w-full border-collapse">
              <thead>
                <tr className={GRID_HEADER}>
                  <th className={cn(GRID_TH, "text-left")}>Ticker</th>
                  <th className={cn(GRID_TH, "text-right")}>B/S</th>
                  <th className={cn(GRID_TH, "text-right")}>Net</th>
                </tr>
              </thead>
              <tbody>
                {data.top.slice(0, 6).map((t, i) => (
                  <tr key={t.symbol} className={gridRow(i)}>
                    <td className={GRID_TD}><Link href={`/watchlist?ticker=${t.symbol}`} className="hover:text-[#d4af37]">{t.symbol}</Link></td>
                    <td className={cn(GRID_TD, "text-right")}>{t.buys}/{t.sells}</td>
                    <td className={cn(GRID_TD, "text-right", t.netUsd >= 0 ? "text-green-400" : "text-red-400")}>{usd(t.netUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[9px] uppercase tracking-wide text-[#d4af37]">Latest disclosures</div>
          <div className={cn(GRID_WRAP, "max-h-[260px]")}>
            <table className="w-full border-collapse">
              <thead>
                <tr className={GRID_HEADER}>
                  <th className={cn(GRID_TH, "text-left")}>Disc.</th>
                  <th className={cn(GRID_TH, "text-left")}>Ticker</th>
                  <th className={cn(GRID_TH, "text-left")}>Side</th>
                  <th className={cn(GRID_TH, "text-right")}>Lag</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.slice(0, 30).map((r, i) => (
                  <tr key={`${r.link}${i}`} className={gridRow(i)}>
                    <td className={GRID_TD}>{formatMdYy(r.disclosedDate)}</td>
                    <td className={GRID_TD}>
                      <DataTip tip={`${r.member ?? ""} (${r.chamber}) · ${r.amountText ?? ""}`}>
                        <Link href={`/watchlist?ticker=${r.symbol}`} className="hover:text-[#d4af37]">{r.symbol}</Link>
                      </DataTip>
                    </td>
                    <td className={cn(GRID_TD, typeCls(r.type))}>{r.type}</td>
                    <td className={cn(GRID_TD, "text-right")}>{r.lagDays != null ? `${r.lagDays}d` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="text-[9px] text-amber-100">History since {formatMdYy(data.coverage.since)} · {data.coverage.rows} rows</div>
        </>
      )}
    </div>
  );
}
