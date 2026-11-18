// Fear curve + credit + tenor cost (Jamie 11-17: "show the VIX vs 3m VIX spread chart… credit spreads as a chart… why 6 m?").
// Ratio + HY come from GET /api/today/overview (bottom.series); tenor cost from GET /api/today/tenor-cost (live chains, 1 h cache).
// Used on Today (under the bottom checklist) and Macro (Volatility section).
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH } from "@/lib/score-explain-format";
import { RateHistoryChart } from "@/components/macro/macro-history-charts";

type Pt = { date: string; value: number };
type TenorRow = { ticker: string; iv3: number | null; iv6: number | null; cost3: number | null; cost6: number | null; dte3: number | null; dte6: number | null };

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

export function FearCurveCharts({ ratio, hy }: { ratio: Pt[]; hy: Pt[] }) {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2" data-testid="fear-curve-charts">
      <div title="VIX ÷ VIX3M. Above 1 = near-term fear above 3-month fear (panic). The tested market-bottom buy (S172) is the first close back below 1 after ≥ 2 days above it. Day-1 spikes out of a calm curve fade 58 % of the time by the next day (S199).">
        <RateHistoryChart title="Fear curve — VIX ÷ VIX3M (above 1 = panic)" data={ratio} color="#facc15" loading={false} compact
          yFormatter={(v) => v.toFixed(2)} tooltipFormatter={(v) => [v.toFixed(3)]}
          referenceLines={[{ y: 1, label: "1.0 panic line", color: "#ef4444" }]} />
      </div>
      <div title="ICE BofA US High Yield OAS (FRED). Stocks bouncing while this widens = a suspect bounce. Context only — not tested as a timing rule here.">
        <RateHistoryChart title="Junk-bond spread — HY OAS %" data={hy} color="#fb923c" loading={false} compact />
      </div>
    </div>
  );
}

const TH = cn(GRID_TH, "px-1.5 py-0.5");
const TD = "px-1.5 py-0.5 text-[11px] font-mono text-right";
const pc = (x: number | null, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}`);

export function TenorCostTable() {
  const { data, error, isLoading } = useQuery<{ rows: TenorRow[] }>({
    queryKey: ["today-tenor-cost"], queryFn: () => getJson("/api/today/tenor-cost"), staleTime: 30 * 60_000,
  });
  return (
    <section className={GRID_WRAP} data-testid="tenor-cost">
      <div className={cn(GRID_HEADER, "px-1.5")} title="ATM implied vol per year at the ~3-month and ~6-month expiries, from live chains. Cost = an at-the-money call as % of the stock price (≈ 0.4 × IV × √years). Per-day cost = cost ÷ days. The VIX index curve is S&P options incl. wings — your names' own curves are what you pay.">
        3 vs 6 month calls on your names — what you actually pay
      </div>
      {isLoading && <div className="px-2 py-1 text-[11px] text-amber-200/60">loading live chains…</div>}
      {error && <div className="px-2 py-1 text-[11px] text-red-400">tenor cost failed: {String(error)}</div>}
      {data && (
        <table className="w-full">
          <thead>
            <tr>
              <th className={cn(TH, "text-left")}>Name</th><th className={TH}>IV 3 m</th><th className={TH}>IV 6 m</th>
              <th className={TH}>ATM call 3 m</th><th className={TH}>ATM call 6 m</th><th className={TH}>6 m price ×</th><th className={TH}>for time ×</th>
              <th className={TH} title="Cost per day of time bought, 6 m ÷ 3 m. Under 1 = the 6 m is cheaper per day.">per-day 6 m ÷ 3 m</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const px = r.cost3 && r.cost6 ? r.cost6 / r.cost3 : null, tx = r.dte3 && r.dte6 ? r.dte6 / r.dte3 : null;
              const perDay = px && tx ? px / tx : null;
              const ivUp = r.iv3 != null && r.iv6 != null && r.iv6 > r.iv3;
              return (
                <tr key={r.ticker} className="border-t border-white/5">
                  <td className={cn(TD, "text-left text-amber-100")}>{r.ticker}</td>
                  <td className={TD}>{pc(r.iv3)}</td>
                  <td className={cn(TD, ivUp && "text-orange-300")} title={ivUp ? "6 m IV above 3 m — the kink Jamie flagged" : undefined}>{pc(r.iv6)}</td>
                  <td className={TD}>{pc(r.cost3, 1)} %</td>
                  <td className={TD}>{pc(r.cost6, 1)} %</td>
                  <td className={TD}>{px ? `${px.toFixed(2)}×` : "—"}</td>
                  <td className={TD}>{tx ? `${tx.toFixed(2)}×` : "—"}</td>
                  <td className={cn(TD, perDay != null && (perDay < 1 ? "text-green-400" : "text-red-400"))}>{perDay ? perDay.toFixed(2) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}

// Macro tab: same charts, self-fetching (Today passes series it already has).
export function FearCurvePanel() {
  const { data } = useQuery<{ bottom?: { series?: { ratio: Pt[]; hy: Pt[] } } }>({
    queryKey: ["today-overview"], queryFn: () => getJson("/api/today/overview"), staleTime: 5 * 60_000,
  });
  const s = data?.bottom?.series;
  return s ? <FearCurveCharts ratio={s.ratio} hy={s.hy} /> : null;
}
