// Jamie 11-20: "you are not looking at the unrealized losses" + "should I really be turning margin off? that's like turning
// it off at the low". Answer in the UI: not "sell because it fell" (fast drops had no further edge, check 11-20) but "how far
// can SPY fall before the broker sells for you" per margin account, the smallest sale that restores a 10 % cushion
// (capital-plan order), red holdings still owned, and green names in a fast drop. Data: GET /api/today/book-risk.
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { GRID_WRAP, GRID_HEADER, GRID_TH } from "@/lib/score-explain-format";

type Trim = { ticker: string; what: string; sell: number; ofCash: number; why: string; tier: number; cushionAfter: number | null };
type Acct = { name: string; stockValue: number; gross: number; net: number; loan: number; buyingPower: number | null; beta: number | null;
  loss5: number; loss10: number; ratio: number | null; ratioAt10: number | null; cushion: number | null;
  trims: Trim[]; cushionAfter: number | null; reached: boolean | null };
type Red = { ticker: string; account: string; value: number; since: string; sinceAtLeast: boolean; sinceChange: number | null; pnl: number | null };
type Alarm = { ticker: string; account: string; value: number; own: number | null; ret10: number | null; fallingKnife: boolean };
type Resp = { snapshotAt: string | null; beta: number | null; loss5: number; loss10: number; loan: number; state: "call-risk" | "watch" | "ok";
  market: { fear: number | null; invertedDays: number; read: string }; accounts: Acct[]; red: Red[]; alarms: Alarm[]; floor: number; target: number };

const TD = "px-1.5 py-0.5 text-[13px] text-white";
const usd = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(Math.round(x)).toLocaleString("en-US")}`;
const pct = (x: number | null, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)} %`);
const signed = (x: number | null) => (x == null ? "—" : <span className={x < 0 ? "text-red-400" : "text-emerald-400"}>{usd(x)}</span>);

function Head({ tip, children }: { tip: string; children: React.ReactNode }) {
  return (
    <div className={cn(GRID_HEADER, "px-2 py-1")}>
      <DataTip tip={tip}><span className="text-[13px] font-semibold uppercase tracking-wide text-white">{children}</span></DataTip>
    </div>
  );
}

export function BookRiskCard() {
  const { data } = useQuery<Resp>({
    queryKey: ["today-book-risk"],
    queryFn: async () => {
      const r = await fetch("/api/today/book-risk", { credentials: "include" });
      if (!r.ok) throw new Error(`book-risk ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  if (!data) return null;
  const margin = data.accounts.filter((a) => a.loan > 0);
  const tight = margin.filter((a) => a.cushion != null && a.cushion < data.target);
  const fear = data.market.fear;
  const headline = tight.length
    ? tight.map((a) => `${a.name}: a ${pct(a.cushion, 1)} SPY drop reaches a margin call`).join(" · ")
    : margin.length ? `Margin accounts clear a ${pct(data.target)} SPY drop` : "No margin loan";
  return (
    <section className={GRID_WRAP} data-testid="today-book-risk">
      <Head tip={`From the RH snapshot ${data.snapshotAt?.slice(0, 16) ?? "—"}. Beta = 120-day daily beta vs SPY per stock (1.5 when there's under 40 days of history). Margin call line = equity ÷ stock value at ${pct(data.floor)} (RH minimum; volatile names carry higher house rates, and negative buying power means you are already at the line). Options are left out of the beta.`}>
        Book risk · beta {data.beta?.toFixed(1) ?? "—"} · SPY −5 % ≈ {usd(-data.loss5)} · −10 % ≈ {usd(-data.loss10)}
      </Head>
      <div className={cn("px-2 py-1 text-[13px] font-semibold", tight.length ? "text-red-400" : "text-white")}>
        {headline}
        {fear != null && <span className="font-normal text-white"> · fear curve {fear.toFixed(2)}{fear >= 1 ? ` (inverted ${data.market.invertedDays} d)` : ""}</span>}
      </div>
      <div className="px-2 pb-1 text-[12px] text-white">
        <DataTip tip="Check 11-20 on prices since 2025-06: names that fell ≥ 25 % in 10 days returned +3.0 % over the next 20 days (n 1,931) vs +1.7 % for the rest, with a worse bottom 10 % (−23 % vs −12 %). So selling after a drop has no edge on average; what it buys is staying out of a forced sale.">
          <span>Not a call on the market: the goal is that another leg down can't force a sale at the low. Sell only what restores a {pct(data.target)} cushion, weakest names first.</span>
        </DataTip>
      </div>
      <table className="w-full">
        <thead>
          <tr>
            {["Account", "Stocks", "Loan", "Beta", "SPY −5 %", "SPY −10 %", "Equity now → at −10 %", "Margin call at SPY"].map((h) => (
              <th key={h} className={GRID_TH}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.accounts.map((a) => (
            <tr key={a.name} className="border-t border-white/10">
              <td className={TD}>{a.name}</td>
              <td className={TD}>{usd(a.stockValue)}</td>
              <td className={TD}>{a.loan ? usd(a.loan) : "—"}</td>
              <td className={TD}>{a.beta?.toFixed(1) ?? "—"}</td>
              <td className={cn(TD, "text-red-400")}>{usd(-a.loss5)}</td>
              <td className={cn(TD, "text-red-400")}>{usd(-a.loss10)}</td>
              <td className={TD}>{a.ratio == null ? "no loan" : `${pct(a.ratio)} → ${pct(a.ratioAt10)}`}</td>
              <td className={cn(TD, "font-semibold", a.cushion != null && a.cushion < data.target ? "text-red-400" : "text-white")}>
                {a.cushion == null ? "—" : `−${pct(a.cushion, 1)}`}
                {a.buyingPower != null && a.buyingPower < 0 && <span className="font-normal"> · buying power {usd(a.buyingPower)}</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {tight.filter((a) => a.trims.length).map((a) => (
        <div key={a.name} className="border-t border-white/10">
          <div className="px-2 pt-1 text-[13px] font-semibold text-white">
            {a.name}: sell {usd(a.trims.reduce((s, t) => s + t.sell, 0))} → margin call moves to SPY −{pct(a.cushionAfter, 1)}
            {a.reached === false && <span className="text-red-400"> (holdings can't reach −{pct(data.target)})</span>}
          </div>
          <table className="w-full">
            <tbody>
              {a.trims.map((t) => (
                <tr key={t.ticker} className="border-t border-white/10">
                  <td className={cn(TD, "w-[220px]")}>
                    {t.sell >= t.ofCash - 1 ? t.what : `sell ${usd(t.sell)} of ${t.ticker} (of ${usd(t.ofCash)})`}
                  </td>
                  <td className={cn(TD, "w-[90px]")}>{usd(t.sell)}</td>
                  <td className={TD}><DataTip tip={t.why}><span>{t.why.split(" · ")[0]}</span></DataTip></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {data.red.length > 0 && (
        <div className="border-t border-white/10">
          <div className="px-2 pt-1 text-[13px] font-semibold text-white">
            <DataTip tip="Model List verdict red = Fildi would not own it (risk flags: balance sheet, analyst cuts, weak fundamentals, short interest). 'Since red' = change in this position's value since the first red day.">
              <span>Red holdings you still own · {usd(data.red.reduce((s, r) => s + r.value, 0))} · {signed(data.red.reduce((s, r) => s + (r.sinceChange ?? 0), 0))} since red</span>
            </DataTip>
          </div>
          <table className="w-full">
            <thead><tr>{["Ticker", "Account", "Value", "Red since", "Since red", "Total P&L"].map((h) => <th key={h} className={GRID_TH}>{h}</th>)}</tr></thead>
            <tbody>
              {data.red.map((r) => (
                <tr key={r.ticker + r.account} className="border-t border-white/10">
                  <td className={cn(TD, "font-semibold")}>{r.ticker}</td>
                  <td className={TD}>{r.account}</td>
                  <td className={TD}>{usd(r.value)}</td>
                  <td className={TD}>{r.sinceAtLeast ? "≤ " : ""}{r.since.slice(5)}</td>
                  <td className={TD}>{signed(r.sinceChange)}</td>
                  <td className={TD}>{signed(r.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.alarms.length > 0 && (
        <div className="border-t border-white/10 px-2 py-1 text-[13px] text-white">
          <DataTip tip="Green = business quality (fundamentals, credit, analyst revisions), not a price call. A green name in a fast drop is a sizing question: no extra edge in selling it, but it is the biggest swing in the book.">
            <span>
              <span className="font-semibold text-amber-300">Green but falling fast: </span>
              {data.alarms.map((x) => `${x.ticker} ${x.account} ${usd(x.value)} · own ${x.own?.toFixed(0) ?? "—"} · ${pct(x.ret10)} in 10 d${x.fallingKnife ? " · falling knife" : ""}`).join(" — ")}
            </span>
          </DataTip>
        </div>
      )}
    </section>
  );
}
