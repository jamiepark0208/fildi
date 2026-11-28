// Jamie 11-27 (S212): deep-OTM risk reversals for ~$0 — sell a 0.10–0.16Δ put, buy the highest-delta call its mid pays for,
// same expiry. Built daily by scripts/watchlist_sync/analysis/s212_rr_screen.py (rules + leg checks live there) →
// rr_s212_daily → GET /api/today/risk-reversals/deep. Order = the screen's rank; SMH row is the no-single-name comparator.
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { GRID_HEADER, GRID_TH } from "@/lib/score-explain-format";

type Leg = { strike: number; bid: number; ask: number; mid: number; delta: number; oi: number; my_iv: number | null;
  lse_iv: number | null; spread_pct: number; verified_by?: string | null; flags: string[] };
type Row = { rank: number; ticker: string; spot: number; expiry: string; put: Leg; call: Leg; mid_net: number; fill_net: number;
  put_otm: number; call_otm: number; delta_ratio: number; skew15: number | null; er_in: boolean; next_er: string | null;
  final: number | null; fund: number | null; dd52: number | null; rsi14: number | null; peer: string | null;
  worst_crash_pnl: number | null; er_breach: number | null; er_n: number };
type Resp = { asOf: string | null; names: Row[]; etfs: Row[] };

const REPORT = "https://claude.ai/artifact/6VfDVSzoVNfpmCbGUULGTF";
// S213 (11-27): same-exposure replay 2019–2025 of this exact shape (0.12Δ put / 0.18Δ call, 7-week hold) ≈ shares (−1 pt, CI −3…+2), collateral 2.6× the cash.
const S213 = "https://claude.ai/artifact/KwohjSz9JhL39FwUU6fFrL";
const S213_TIP = "S213 replay 2019–2025, this shape (sell 0.12Δ put, buy 0.18Δ call, held 7 weeks), names ≥ 25 % off high, same starting exposure as shares:\n"
  + "−1 pt vs owning the shares (95 % CI −3…+2, 70 months). Cash-secured it ties up 2.6× the cash of the same shares. Cash per lot = put strike × 100.";
const TH = cn(GRID_TH, "px-1.5 py-0.5");
const TD = "px-1.5 py-0.5 font-mono text-[13px] whitespace-nowrap";
const pct = (x: number | null | undefined, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const TIP = "Sell a deep out-of-the-money put (0.10–0.16Δ) and use its premium to buy the highest-delta call it pays for, same expiry "
  + "(before most late-January earnings). Δ ratio = call delta ÷ put delta: above 1 = more upside than downside for ~$0. "
  + "Legs: Schwab quotes, our IV solved from mid, open interest ≥ 100; each leg is cross-checked against real OPRA trades (LSE). "
  + "Worst crash = this trade through the stock's own worst drop of the same length in 2020, 2022 or 2025, at expiry. "
  + "Ranked by fund score, estimate revisions, drawdown, IV and the option terms (S212).";

function legTip(name: string, l: Leg) {
  return `${name} ${l.strike}: bid ${l.bid} / ask ${l.ask} · mid ${l.mid.toFixed(2)} · Δ ${l.delta.toFixed(2)} · OI ${l.oi}`
    + ` · IV ${pct(l.my_iv, 1)} (trades ${pct(l.lse_iv, 1)}) · spread ${pct(l.spread_pct)}`
    + (l.flags.length ? `\n${l.flags.join("; ")}` : "\nclean");
}

export function DeepRiskReversalCard() {
  const { data } = useQuery<Resp>({
    queryKey: ["today-risk-reversals-deep"],
    queryFn: async () => {
      const r = await fetch("/api/today/risk-reversals/deep", { credentials: "include" });
      if (!r.ok) throw new Error(`risk-reversals/deep ${r.status}`);
      return r.json();
    },
    staleTime: 30 * 60_000,
  });
  if (!data?.names.length) return null;
  const smh = data.etfs.find((e) => e.ticker === "SMH");
  return (
    <div className="rounded-md border border-[#d4af37]/25 bg-black overflow-hidden" data-testid="today-risk-reversals-deep">
      <div className={cn(GRID_HEADER, "px-2 py-1 flex items-center gap-3 flex-wrap")}>
        <DataTip tip={TIP}>
          <span className="text-[13px] font-semibold text-[#d4af37]">
            Deep OTM risk reversals · ~$0 · {data.names[0].expiry.slice(5)} · {data.names.length} names
          </span>
        </DataTip>
        {smh && <span className="text-[12px] text-amber-100">SMH same trade: Δ ratio {smh.delta_ratio.toFixed(2)}</span>}
        <span className="text-[12px] text-amber-100">quotes {data.asOf}</span>
        <DataTip tip={S213_TIP}>
          <span className="text-[12px] text-amber-100">≈ owning the shares · needs margin</span>
        </DataTip>
        <a href={S213} target="_blank" rel="noreferrer" className="ml-auto text-[12px] text-[#d4af37] underline">vs shares / LEAPS / wheel</a>
        <a href={REPORT} target="_blank" rel="noreferrer" className="text-[12px] text-[#d4af37] underline">11-27 full report</a>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-white">
          <thead>
            <tr>
              <th className={TH}>#</th><th className={TH}>Ticker</th><th className={TH}>Sell put</th><th className={TH}>Buy call</th>
              <th className={TH}>Net</th><th className={TH}>Cash / lot</th><th className={TH}>Δ ratio</th><th className={TH}>Off high</th>
              <th className={TH}>Worst crash / lot</th><th className={TH}>Earnings</th><th className={TH}>Legs</th>
            </tr>
          </thead>
          <tbody>
            {data.names.map((r) => {
              const checked = [r.put, r.call].some((l) => l.verified_by === "lse");
              const beatsSmh = smh ? r.delta_ratio > smh.delta_ratio + 0.05 : false;
              return (
                <tr key={r.ticker} className="border-t border-[#d4af37]/10">
                  <td className={TD}>{r.rank}</td>
                  <td className={cn(TD, "font-semibold")} title={`${r.peer ?? ""} · fund ${r.fund?.toFixed(0) ?? "—"} · RSI ${r.rsi14?.toFixed(0) ?? "—"}`}>{r.ticker}</td>
                  <td className={TD} title={legTip("Sell put", r.put)}>{r.put.strike} <span className="text-amber-100">−{pct(r.put_otm)} · Δ{r.put.delta.toFixed(2)}</span></td>
                  <td className={TD} title={legTip("Buy call", r.call)}>{r.call.strike} <span className="text-amber-100">+{pct(r.call_otm)} · Δ{r.call.delta.toFixed(2)}</span></td>
                  <td className={TD} title={`at a realistic fill ${r.fill_net >= 0 ? "+" : ""}${r.fill_net.toFixed(2)}`}>{r.mid_net >= 0 ? "+" : ""}{r.mid_net.toFixed(2)}</td>
                  <td className={TD} title="cash-secured: put strike × 100 (margin accounts need less, but the loss is the same)">${(r.put.strike * 100).toLocaleString()}</td>
                  <td className={cn(TD, beatsSmh ? "text-green-400" : "")}>{r.delta_ratio.toFixed(2)}</td>
                  <td className={TD}>{pct(r.dd52)}</td>
                  <td className={cn(TD, "text-red-400")}>{r.worst_crash_pnl == null ? "—" : `${Math.round(r.worst_crash_pnl).toLocaleString()}`}</td>
                  <td className={cn(TD, r.er_in ? "text-red-400" : "")}>{r.er_in ? `⚠ ${r.next_er?.slice(5)}` : r.next_er?.slice(5) ?? "—"}</td>
                  <td className={cn(TD, checked ? "text-amber-300" : "text-green-400")}
                      title={checked ? "after-close spread wide; mid confirmed by real trades — check the quote live" : "clean quotes"}>
                    {checked ? "trade-checked" : "clean"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
