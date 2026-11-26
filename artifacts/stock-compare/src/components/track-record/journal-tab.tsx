/**
 * Track Record › Journal (A393). Admin-only. Reads /api/trade-journal — never computes trades.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
import { TickerLink } from "@/components/ticker-link";

interface Row {
  orderId: string;
  at: string;
  day: string;
  symbol: string;
  kind: "stock" | "option";
  action: string;
  optionSide: "put" | "call" | null;
  strike: number | null;
  expiry: string | null;
  qty: number;
  px: number;
  premium: number;
  fees: number | null;
  status: string;
  pnl: number | null;
  pct: number | null;
  touched: boolean | null;
  matchedOpenDay: string | null;
  fildi: string;
  tag: string;
  otmPct: number | null;
  offHighPct: number | null;
  pKept: number | null;
}
interface OddsCell { ddLo: number; ddHi: number; otmLo: number; otmHi: number; pModel: number; n: number; kept: number | null; avgRet: number | null }
interface PutOdds { meta: { n: number; brier: number; brier_base: number; kept: number }; cells: OddsCell[] }
// A410/S192 confidence scale (Jamie 11-16): producer = scripts/watchlist_sync/jamie_traits.py
const ODDS_TIP = "Odds your sold put expires worthless, from your own put sales: the further the stock is below its 60-day high and the further the strike is below the price, the higher the odds. Big number = smooth fit; 'actual' = what happened in that box. Fit is checked on months it never saw. Your history, not a forecast.";
// S194 (Jamie 11-17: "differentiate between good and bad trades"): sold-put opens graded at expiry
const GRADE_TIP = "How the sold put went, held to expiry. Clean = kept the premium, stock never traded below the strike. Risky win = kept money but the strike was touched. Loss = lost money. Across your 1,526 put sales: clean 66 % (avg +1.09 % of strike), risky win 16 % (+1.05 %), loss 18 % (−3.87 %). In the same week, the one entry trait that splits clean from risky/loss is strike depth (clean median 12 % below price vs 8 %); how beaten-down the stock was mostly reflects the market week, not the pick.";
function putGrade(r: { action: string; status: string; touched: boolean | null; pct: number | null }): [string, string] | null {
  if (r.action !== "sell put open" || r.status !== "expired" || r.touched == null || r.pct == null) return null;
  if (r.pct < 0) return ["Loss", "text-red-400"];
  return r.touched ? ["Risky win", "text-amber-300"] : ["Clean", "text-emerald-400"];
}
interface Sum { trades: number; winPct: number | null; pnl: number; avgPct: number | null }
interface Resp {
  days: number;
  count: number;
  summary: Sum & {
    byTag: Array<Sum & { tag: string }>;
    jamiePuts: { n: number; avgPct: number | null };
    enginePass: { n: number; avgPct: number | null };
    putOdds?: PutOdds | null;
    vsEngine?: VsEngine | null;
  };
  rows: Row[];
}

const money = (v: number | null) => (v == null ? "—" : `${v < 0 ? "−" : "+"}$${Math.abs(Math.round(v)).toLocaleString()}`);
const pct = (v: number | null, d = 2) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
const tone = (v: number | null) => (v == null ? "text-amber-100" : v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-white");
const oddsTone = (p: number | null) => (p == null ? "text-amber-100" : p >= 0.9 ? "text-emerald-400" : p >= 0.8 ? "text-white" : p >= 0.7 ? "text-amber-200" : "text-rose-400");
const band = (lo: number, hi: number) => (lo <= -50 ? `< ${hi}%` : hi >= 99 ? `${lo}%+` : `${lo}–${hi}%`);

// S207 (Jamie 11-26: "not enough evidence … our model is … better than the trades that i placed"): producer
// scripts/watchlist_sync/analysis/s207_jamie_vs_engine.py (daily via learn_cells). Same weeks, same unit.
interface VsRow { book: string; bpWk: number; medianBpWk: number; sdBp: number; worst3Bp: number; vsEngineBp: number | null; t: number | null; n: number }
interface VsEngine {
  asOf: string; bookEnd: string; weeks: number; jamieFrom: string; jamiePositions: number; jamieNames: number;
  rows: VsRow[]; beatEngineWeeksPct: number; worstWeeks: Array<{ week: string; vsEngineBp: number }>;
  earlyClose: { usdIfHeld: number; n: number; profitTakesUsd: number; lossClosesUsd: number }; calibration: number | null;
}
const VS_LABELS: Array<[string, string]> = [
  ["Engine picks", "Top third of the week's ~1σ weekly puts by the live put score (A352 rebuild, inputs known at entry, net of fill cost)."],
  ["Random pick", "Every name's ~1σ weekly put that week — what picking blind at the same distance earns."],
  ["You, as traded", "Your real fills and your real exits (buy-to-close matched first-in first-out), all RH accounts."],
  ["You, held to expiry", "Your same contracts if you had never closed early: premium − intrinsic at the expiry close."],
  ["Your names, engine strike", "The names you sold that week, but at the engine's ~1σ weekly strike — separates your name choice from your strike/exit choice."],
];
const bpf = (v: number | null) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}`);

function VsEngineCard({ v }: { v: VsEngine }) {
  const [eng, rnd, act] = v.rows;
  const sig = (r?: VsRow) => r?.t != null && Math.abs(r.t) >= 2;
  return (
    <div className="rounded border border-[#d4af37]/15 bg-zinc-950/80 px-2.5 py-2 space-y-1.5" data-testid="journal-vs-engine">
      <DataTip tip={`Every short put you sold since ${v.jamieFrom} (${v.jamiePositions} positions, ${v.jamieNames} names) against the engine in the same ${v.weeks} weeks (engine history ends ${v.bookEnd}). Unit: bp of strike per week the collateral was tied up (cash-secured). 'vs engine' is paired by week; t ≥ 2 = real difference. Engine side is model-priced; your real fills ran ${v.calibration?.toFixed(2) ?? "—"}× the model price on your own contracts, so the engine numbers are not inflated. Updated ${v.asOf}.`}>
        <div className="text-[10px] uppercase tracking-wide text-white font-semibold">You vs the engine — all your put sales, same weeks</div>
      </DataTip>
      <div className="text-[11px] text-amber-100 space-y-0.5">
        <div>
          <span className="text-white font-semibold">Engine beats random</span> by {bpf(eng.bpWk - rnd.bpWk)} bp/wk{sig(rnd) ? " (real, t " + Math.abs(rnd.t ?? 0).toFixed(1) + ")" : " (not significant)"} — the ranking works.
        </div>
        <div>
          <span className="text-white font-semibold">You vs engine:</span> {bpf(act.bpWk)} vs {bpf(eng.bpWk)} bp/wk{sig(act) ? "" : " — no real return difference"}; you win more weeks ({v.beatEngineWeeksPct.toFixed(0)}%) but swing {(act.sdBp / eng.sdBp).toFixed(1)}× more. Your worst 3 weeks avg {bpf(act.worst3Bp)} vs {bpf(eng.worst3Bp)}.
        </div>
        <div>
          <span className="text-white font-semibold">Holding to expiry instead of closing early would have added {money(v.earlyClose.usdIfHeld)}</span> over {v.earlyClose.n} positions (profit-takes {money(v.earlyClose.profitTakesUsd)}, loss closes {money(v.earlyClose.lossClosesUsd)}).
        </div>
      </div>
      <div className={GRID_WRAP}>
        <table className="w-full">
          <thead className={GRID_HEADER}>
            <tr>
              <th className={cn(GRID_TH, "text-left")}>Book</th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Mean bp of strike per collateral-week across the paired weeks.">Avg bp/wk</DataTip></th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Median week.">Typical wk</DataTip></th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Standard deviation of weekly bp — how much it swings.">Swing</DataTip></th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Average of the 3 worst weeks.">Worst 3 wks</DataTip></th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Mean weekly difference vs Engine picks, same weeks; t in brackets (|t| ≥ 2 = real).">vs engine</DataTip></th>
            </tr>
          </thead>
          <tbody>
            {v.rows.map((r, i) => (
              <tr key={r.book} className={gridRow(i)}>
                <td className={cn(GRID_TD, "text-left")}><DataTip tip={VS_LABELS[i]?.[1] ?? r.book}>{VS_LABELS[i]?.[0] ?? r.book}</DataTip></td>
                <td className={cn(GRID_TD, "text-right tabular-nums", tone(r.bpWk))}>{bpf(r.bpWk)}</td>
                <td className={cn(GRID_TD, "text-right tabular-nums")}>{bpf(r.medianBpWk)}</td>
                <td className={cn(GRID_TD, "text-right tabular-nums")}>{r.sdBp.toFixed(0)}</td>
                <td className={cn(GRID_TD, "text-right tabular-nums", tone(r.worst3Bp))}>{bpf(r.worst3Bp)}</td>
                <td className={cn(GRID_TD, "text-right tabular-nums", tone(r.vsEngineBp))}>
                  {r.vsEngineBp == null ? "—" : `${bpf(r.vsEngineBp)} (${r.t?.toFixed(1) ?? "—"})`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OddsGrid({ odds }: { odds: PutOdds }) {
  const dd = Array.from(new Map(odds.cells.map((c) => [c.ddLo, c])).values());
  const otm = Array.from(new Map(odds.cells.map((c) => [c.otmLo, c])).values());
  const at = (d: number, o: number) => odds.cells.find((c) => c.ddLo === d && c.otmLo === o);
  return (
    <div data-testid="journal-put-odds">
      <DataTip tip={ODDS_TIP}>
        <div className="text-[10px] uppercase tracking-wide text-white font-semibold mb-1">
          Odds your put expires worthless · {odds.meta.n} put sales
        </div>
      </DataTip>
      <div className={GRID_WRAP}>
        <table className="w-auto">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-left")}>Stock below 60-day high</th>
              {otm.map((o) => (
                <th key={o.otmLo} className={cn(GRID_TH, "text-right")}>Strike {band(o.otmLo, o.otmHi)} below</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dd.map((d, i) => (
              <tr key={d.ddLo} className={gridRow(i)}>
                <td className={cn(GRID_TD, "whitespace-nowrap text-white")}>{d.ddHi >= 999 ? `${d.ddLo}%+` : `${d.ddLo}–${d.ddHi}%`}</td>
                {otm.map((o) => {
                  const c = at(d.ddLo, o.otmLo);
                  return (
                    <td key={o.otmLo} className={cn(GRID_TD, "text-right whitespace-nowrap")}>
                      {c ? (
                        <DataTip tip={`Fit ${(c.pModel * 100).toFixed(0)}% · actual ${c.kept == null ? "—" : `${(c.kept * 100).toFixed(0)}%`} of ${c.n} · avg ${pct(c.avgRet)} of strike`}>
                          <span className={cn("font-bold tabular-nums", oddsTone(c.pModel))}>{(c.pModel * 100).toFixed(0)}%</span>
                          <span className="ml-1 text-[9px] text-amber-100">actual {c.kept == null ? "—" : `${(c.kept * 100).toFixed(0)}%`} · n {c.n}</span>
                        </DataTip>
                      ) : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value, sub, tip, cls }: { label: string; value: string; sub?: string; tip: string; cls?: string }) {
  return (
    <div className="rounded border border-[#d4af37]/15 bg-zinc-950/80 px-2.5 py-1 min-w-[96px]">
      <DataTip tip={tip}>
        <div className="text-[9px] uppercase tracking-wide text-[#d4af37]">{label}</div>
      </DataTip>
      <div className={cn("text-sm font-bold tabular-nums", cls)}>{value}</div>
      {sub && <div className="text-[9px] text-amber-100 truncate">{sub}</div>}
    </div>
  );
}

function Seg<T extends string | number>({ value, set, opts }: { value: T; set: React.Dispatch<React.SetStateAction<T>>; opts: Array<[T, string]> }) {
  return (
    <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold">
      {opts.map(([v, l]) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => set(v)}
          className={cn("px-2 py-0.5", value === v ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white hover:text-[#d4af37]")}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function JournalTab() {
  const [days, setDays] = useState(90);
  const [kind, setKind] = useState<"all" | "stock" | "option">("all");
  const [state, setState] = useState<"all" | "open" | "closed">("all");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["trade-journal", days],
    queryFn: async (): Promise<Resp> => {
      const res = await fetch(`/api/trade-journal?days=${days}`);
      if (!res.ok) throw new Error("trade-journal fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r) =>
          (kind === "all" || r.kind === kind) &&
          (state === "all" || (state === "open" ? r.status === "open" : r.status !== "open")),
      ),
    [data, kind, state],
  );

  if (isLoading) return <div className="text-xs text-amber-200/70 py-10 text-center">Loading…</div>;
  if (isError || !data) return <div className="text-xs text-rose-300 py-10 text-center">Journal unavailable.</div>;
  const s = data.summary;
  const gap = s.jamiePuts.avgPct != null && s.enginePass.avgPct != null ? s.jamiePuts.avgPct - s.enginePass.avgPct : null;


  return (
    <div className="space-y-2" data-testid="journal-tab">
      {s.vsEngine && <VsEngineCard v={s.vsEngine} />}
      {s.putOdds && <OddsGrid odds={s.putOdds} />}
      <div className="flex flex-wrap gap-1.5">
        <Stat label="Graded" value={String(s.trades)} sub={`${data.count} fills`} tip="Fills with a P&L: closes (realized, FIFO vs the matching open) and option opens still open or expired (premium − intrinsic at expiry, or last close)." />
        <Stat label="Win" value={s.winPct == null ? "—" : `${s.winPct.toFixed(0)}%`} tip="Share of graded rows with P&L > 0." />
        <Stat label="P&L" value={money(s.pnl)} cls={tone(s.pnl)} tip="Sum of graded P&L, $. Fees only where the broker reported them." />
        <Stat label="Avg % strike" value={pct(s.avgPct)} cls={tone(s.avgPct)} tip="Mean per-share P&L as % of strike (same unit as the rec scoreboard)." />
        <Stat
          label="Jamie vs engine"
          value={gap == null ? "—" : pct(gap)}
          cls={tone(gap)}
          sub={`${pct(s.jamiePuts.avgPct)} (n ${s.jamiePuts.n}) vs ${pct(s.enginePass.avgPct)} (n ${s.enginePass.n})`}
          tip="Short-put opens: your fills vs put-engine PASS recs (bid + 10% of spread) over the same window, graded the same way. Port of scripts/rec_scoreboard.py."
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Seg<number> value={days} set={setDays} opts={[[30, "30d"], [90, "90d"], [365, "365d"]]} />
        <Seg value={kind} set={setKind} opts={[["all", "All"], ["stock", "Stock"], ["option", "Option"]]} />
        <Seg value={state} set={setState} opts={[["all", "All"], ["open", "Open"], ["closed", "Closed"]]} />
        <span className="text-[10px] text-amber-100" data-testid="journal-count">{rows.length} rows</span>
        {s.byTag.length > 0 && (
          <DataTip tip={s.byTag.map((t) => `${t.tag}: n ${t.trades}, ${money(t.pnl)}, ${pct(t.avgPct)}`).join("\n")}>
            <span className="text-[10px] text-amber-100">by tag</span>
          </DataTip>
        )}
      </div>
      <div className={GRID_WRAP}>
        <table className="w-full">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-left")}>Date</th>
              <th className={cn(GRID_TH, "text-left")}>Symbol</th>
              <th className={cn(GRID_TH, "text-left")}>Trade</th>
              <th className={cn(GRID_TH, "text-right")}>Fill</th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Realized on closes (FIFO vs the open); on opens, the unclosed remainder at expiry or last close.">P&amp;L $</DataTip></th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Per-share P&L as % of strike. Split guard skips grades when spot and close differ > 35%.">% strike</DataTip></th>
              <th className={cn(GRID_TH, "text-left")}><DataTip tip={GRADE_TIP}>Result</DataTip></th>
              <th className={cn(GRID_TH, "text-left")}><DataTip tip="Put-engine row for the symbol that day (pass / first failed gate / not scanned) and the Model List folders of the latest run on or before the date.">Fildi said</DataTip></th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip={`${ODDS_TIP} Per trade: fit from the other months only.`}>Odds</DataTip></th>
              <th className={cn(GRID_TH, "text-left")}><DataTip tip="Auto tag from the engine's market/stock state that day.">Tag</DataTip></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.orderId} className={gridRow(i)} data-testid="journal-row">
                <td className={cn(GRID_TD, "whitespace-nowrap")}>{r.day.slice(5)}</td>
                <td className={GRID_TD}><TickerLink ticker={r.symbol} returnLabel="Journal" /></td>
                <td className={cn(GRID_TD, "whitespace-nowrap")}>
                  <DataTip tip={r.matchedOpenDay ? `Closes the ${r.matchedOpenDay} open.` : r.touched == null ? undefined : `Strike touched: ${r.touched ? "yes" : "no"}`}>
                    {r.kind === "option"
                      ? `${r.qty}× ${r.action} ${r.strike} ${r.expiry?.slice(5) ?? ""}`
                      : `${r.qty} ${r.action}`}
                  </DataTip>
                  {r.kind === "option" && r.status !== "closes" && <span className="ml-1 text-[9px] text-amber-100">{r.status}</span>}
                </td>
                <td className={cn(GRID_TD, "text-right")}>
                  <DataTip tip={`Cash ${money(r.premium).replace(/^[+]/, "")}${r.fees != null ? ` · fees $${r.fees}` : ""}`}>{r.px.toFixed(2)}</DataTip>
                </td>
                <td className={cn(GRID_TD, "text-right", tone(r.pnl))}>{money(r.pnl)}</td>
                <td className={cn(GRID_TD, "text-right", tone(r.pct))}>{pct(r.pct)}</td>
                <td className={cn(GRID_TD, "whitespace-nowrap", putGrade(r)?.[1])}>{putGrade(r)?.[0] ?? ""}</td>
                <td className={cn(GRID_TD, "text-white")}>{r.fildi}</td>
                <td className={cn(GRID_TD, "text-right whitespace-nowrap", oddsTone(r.pKept))}>
                  {r.pKept != null ? (
                    <DataTip tip={`Strike ${r.otmPct?.toFixed(1) ?? "—"}% below price · stock ${Math.abs(r.offHighPct ?? 0).toFixed(0)}% below its 60-day high.`}>
                      {(r.pKept * 100).toFixed(0)}%
                    </DataTip>
                  ) : "—"}
                </td>
                <td className={cn(GRID_TD, "text-amber-100")}>{r.tag}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="text-xs text-amber-100 py-6 text-center">No fills.</div>}
      </div>
    </div>
  );
}
