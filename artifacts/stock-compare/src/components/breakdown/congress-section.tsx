/**
 * Breakdown › Congress (A394) — Senate + House STOCK Act disclosures for this ticker. Display only, untested edge.
 * Stored FMP *-latest rows (GET /api/stocks/:t/congress). Disclosure lag is the point: a trade is public 30-45 d late.
 */
import { useQuery } from "@tanstack/react-query";
import { GRID_HEADER, GRID_TD, GRID_TH, GRID_WRAP, gridRow } from "@/lib/score-explain-format";
import { formatMdYy } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";

export type CongressRow = {
  chamber: "senate" | "house";
  symbol: string;
  member: string | null;
  district: string | null;
  owner: string | null;
  txnDate: string | null;
  disclosedDate: string | null;
  lagDays: number | null;
  type: "buy" | "sell" | "exchange" | "other";
  rawType: string | null;
  amountText: string | null;
  link: string | null;
};
export type CongressWindow = { days: number; buys: number; sells: number; buyUsd: number; sellUsd: number; netUsd: number; members: number };
export type Coverage = { since: string | null; rows: number; lastDisclosed: string | null };
type View = { rows: CongressRow[]; d90: CongressWindow; y1: CongressWindow; coverage: Coverage };

export const CONGRESS_TIP =
  "Senate + House periodic transaction reports (STOCK Act) via FMP. Amounts are disclosed ranges (midpoint used for $). Reports arrive up to 45 d after the trade, so the lag column is the stale part. Untested as an edge (Ziobrowski 2004 found Senate excess return; Eggers & Hainmueller 2013 found none) — display only. History accrues from the first sync; our FMP plan serves only the newest 100 rows per chamber.";

export function usd(n: number): string {
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(0)}K`;
  return `${sign}$${a.toFixed(0)}`;
}

export function UntestedChip() {
  return (
    <DataTip tip={CONGRESS_TIP}>
      <span className="rounded border border-amber-400/40 px-1 text-[9px] uppercase tracking-wide text-amber-300">untested — display only</span>
    </DataTip>
  );
}

export const typeCls = (t: CongressRow["type"]) => (t === "buy" ? "text-green-400" : t === "sell" ? "text-red-400" : "text-white");

export function CongressHeaderStats({ ticker }: { ticker: string }) {
  const { data } = useCongress(ticker);
  if (!data) return <UntestedChip />;
  return (
    <div className="flex items-center gap-2">
      {data.rows.length > 0 && (
        <span className="text-[10px] text-white">
          90d <span className="text-green-400">{data.d90.buys}B</span>/<span className="text-red-400">{data.d90.sells}S</span>
        </span>
      )}
      <UntestedChip />
    </div>
  );
}

function useCongress(ticker: string) {
  return useQuery({
    queryKey: ["congress", ticker],
    queryFn: async (): Promise<View> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/congress`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60 * 60_000,
  });
}

export function CongressSection({ ticker }: { ticker: string }) {
  const { data, isLoading } = useCongress(ticker);
  if (isLoading) return <p className="text-[10px] text-amber-100">Loading congress trades…</p>;
  const since = data?.coverage.since ? formatMdYy(data.coverage.since) : null;
  if (!data || data.rows.length === 0) {
    return <p className="text-[10px] text-amber-100">No Senate/House disclosures for {ticker}{since ? ` since ${since}` : ""}.</p>;
  }
  const { d90, y1 } = data;
  const lags = data.rows.map((r) => r.lagDays).filter((x): x is number => x != null).sort((a, b) => a - b);
  const medLag = lags.length ? lags[Math.floor(lags.length / 2)] : null;
  return (
    <div className="space-y-1">
      <p className="text-[10px] leading-snug text-white">
        90d: <span className="text-green-400">{d90.buys} buys {usd(d90.buyUsd)}</span> / <span className="text-red-400">{d90.sells} sells {usd(d90.sellUsd)}</span> ·
        1y: {y1.buys}B/{y1.sells}S net <span className={y1.netUsd >= 0 ? "text-green-400" : "text-red-400"}>{usd(y1.netUsd)}</span> ·
        median lag {medLag ?? "—"} d · history since {since ?? "—"}
      </p>
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-left")}>Traded</th>
              <th className={cn(GRID_TH, "text-left")}>Disclosed</th>
              <th className={cn(GRID_TH, "text-right")}>Lag</th>
              <th className={cn(GRID_TH, "text-left")}>Member</th>
              <th className={cn(GRID_TH, "text-left")}>Ch.</th>
              <th className={cn(GRID_TH, "text-left")}>Side</th>
              <th className={cn(GRID_TH, "text-right")}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r, i) => (
              <tr key={`${r.link}${i}`} className={gridRow(i)}>
                <td className={GRID_TD}>{formatMdYy(r.txnDate)}</td>
                <td className={GRID_TD}>{formatMdYy(r.disclosedDate)}</td>
                <td className={cn(GRID_TD, "text-right")}>{r.lagDays != null ? `${r.lagDays}d` : "—"}</td>
                <td className={cn(GRID_TD, "max-w-[120px] truncate")}>
                  <DataTip tip={`${r.district ?? ""}${r.owner ? ` · owner: ${r.owner}` : ""}${r.rawType ? ` · ${r.rawType}` : ""}`}>
                    {r.link ? <a href={r.link} target="_blank" rel="noreferrer" className="hover:text-[#d4af37]">{r.member ?? "—"}</a> : (r.member ?? "—")}
                  </DataTip>
                </td>
                <td className={GRID_TD}>{r.chamber === "senate" ? "Sen" : "Hse"}</td>
                <td className={cn(GRID_TD, typeCls(r.type))}>{r.type}</td>
                <td className={cn(GRID_TD, "text-right")}>{r.amountText?.replace(/\s/g, "") ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
