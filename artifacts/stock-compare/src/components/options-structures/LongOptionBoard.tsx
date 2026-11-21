/**
 * Rankings › Long options (S086, A244): 11 long-call / long-put angles, top 10 names each, overlap across angles,
 * each angle's out-of-sample backtest on the weeks most like today, and the forward paper record (weekly, graded at
 * expiry, demoted below the paper buy-all baseline). Data: GET /api/options/long-board (daily.py).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
import { formatMdYy } from "@/lib/format";
import { TickerLink } from "@/components/ticker-link";
import { AddToTicket } from "@/components/trade-ticket/TicketButtons";

type Name = { ticker: string; sector: string | null; beta: number | null; overlap: number; strike: number | null;
  debit: number | null; breakeven: number | null; spot: number | null; src: string | null };
type Fwd = { open: number; n: number; wins: number; mean: number | null } | null;
type Side = { edgeAnalog: (number | null)[]; edgeAll: (number | null)[]; option: [number | null, number]; optionUngated?: number | null; optionByDte?: Record<string, number | null>; names: Name[] };
type Strategy = { name: string; status: "" | "ledger" | "failing forward"; insampleAll: boolean; forward: Fwd;
  call: Side; put: Side };
type Board = { asOf: string; expiry: string; analogWeeks: number; buyAll: { call: number; put: number };
  forwardBuyAll: Fwd; buyAllCallByDte?: Record<string, number | null>; techAsOf: string; ibesAsOf: string; strategies: Strategy[];
  overlap: { call: [string, number][]; put: [string, number][] } };

const pct = (v: number | null | undefined, dp = 1) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(dp)}%`);
const px = (v: number | null) => (v == null ? "—" : v.toFixed(v < 100 ? 2 : 0));
const fwdText = (f: Fwd) => (!f ? "" : f.n ? `${f.wins}/${f.n} won · ${pct(f.mean, 0)}` : `${f.open} open`);

function verdict(s: Side, buyAll: number): { label: string; cls: string; tip: string } {
  const [edge, t] = s.edgeAnalog;
  const opt = s.option[0];
  if (edge != null && t != null && t >= 2 && opt != null && opt > buyAll)
    return { label: "works", cls: "text-emerald-400 border-emerald-400/40",
      tip: "Picks beat the average stock (t ≥ 2) on weeks like today, and their options beat buying every option. Out-of-sample." };
  if (opt != null && opt > buyAll)
    return { label: "options only", cls: "text-amber-300 border-amber-300/40",
      tip: "Options beat buy-all, but the stock edge is not reliable (t < 2) — likely cheap IV, not a better pick." };
  return { label: "no edge", cls: "text-amber-100 border-zinc-500/40",
    tip: "Options did no better than buying every option on the same weeks." };
}

function NamesTable({ side, rows }: { side: "call" | "put"; rows: Name[] }) {
  return (
    <div className={GRID_WRAP}>
      <table className="w-full">
        <thead className={GRID_HEADER}>
          <tr>
            {["Ticker", "Lists", "β", "Strike", "Cost", "Breakeven"].map((h, i) => (
              <th key={h} className={cn(GRID_TH, i ? "text-right" : "text-left")}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.ticker} className={gridRow(i)}>
              <td className={GRID_TD}>
                <DataTip tip={r.sector ?? "Sector unknown"}><TickerLink ticker={r.ticker} /></DataTip>
              </td>
              <td className={cn(GRID_TD, "text-right", r.overlap > 1 && "text-[#d4af37] font-semibold")}>
                <DataTip tip={`On ${r.overlap} of the ${side} lists`}>{r.overlap > 1 ? `×${r.overlap}` : "1"}</DataTip>
              </td>
              <td className={cn(GRID_TD, "text-right")}>{r.beta == null ? "—" : r.beta.toFixed(1)}</td>
              <td className={cn(GRID_TD, "text-right")}>
                <DataTip tip={`Near-the-money, ~45 days. Spot ${px(r.spot)}`}>{px(r.strike)}</DataTip>
              </td>
              <td className={cn(GRID_TD, "text-right")}>
                <DataTip tip={r.src === "schwab ask"
                  ? "Schwab ask per share (latest chain snapshot)."
                  : "Model price per share: Black-Scholes at IV30 × skew, fill = bid + 23 % of spread (no Schwab quote near the money)."}>
                  <span className={r.src === "schwab ask" ? "text-white" : "text-amber-100/60"}>{px(r.debit)}</span>
                </DataTip>
              </td>
              <td className={cn(GRID_TD, "text-right")}>
                <DataTip tip={`Stock must move this much by expiry to break even (${side === "call" ? "up" : "down"}).`}>
                  {pct(r.breakeven)}
                </DataTip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** `side` = embed under Long call / Long put in StructureLab (no separate tab). */
type S171Pick = { ticker: string; entry: string; gradeOn: string; beat: boolean | null; strike: number; expiry: string;
  ask: number; delta: number; retCall: number | null; vsDelta: number | null; exitFill: string | null };
type S171Summary = { n: number; open: number; dates: number; meanVsDelta: number | null; t: number | null };

function S171Paper({ picks, sum }: { picks: S171Pick[]; sum: S171Summary }) {
  const [show, setShow] = useState(false);
  return (
    <div className="rounded border border-[#d4af37]/20 bg-zinc-950">
      <button type="button" onClick={() => setShow(!show)}
        className="w-full flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1 text-left">
        {show ? <ChevronDown className="w-3 h-3 text-[#d4af37] shrink-0" />
          : <ChevronRight className="w-3 h-3 text-[#d4af37] shrink-0" />}
        <DataTip tip={"S171 rule, frozen: loss-making names with momentum (20-day return ≥ 17 %, RSI ≥ 63, 5-day ≥ 8 %) while their own IV/RV sits in its bottom third. Buy the ~30-day ~0.30Δ call at the Schwab ask the session after the signal, sell at the bid 3 trading days later.\n\nBacktest (2024-07→): beat buying the same-Δ in stock by +142 bp per $ per day, both halves, but t 1.06 — too few dates to trust. Graded live here. Promote at ≥ 100 picks with mean > 0 and t ≥ 2."}>
          <span className="font-semibold text-white underline decoration-dotted cursor-help">Paper: loss-maker momentum + cheap vol calls (S171)</span>
        </DataTip>
        <span className="rounded border border-zinc-500/40 px-1 text-[10px] uppercase text-amber-100">paper</span>
        <span className="tabular-nums text-amber-100">
          {sum.n ? `${sum.n}/100 graded · vs same-Δ stock ${pct(sum.meanVsDelta, 0)} · t ${sum.t?.toFixed(1) ?? "—"}` : "0/100 graded"}
          {sum.open ? ` · ${sum.open} open` : ""}
        </span>
      </button>
      {show ? (
        <div className="px-2 pb-2">
          {picks.length === 0 ? <p className="text-amber-100">No signals yet.</p> : (
            <div className={GRID_WRAP}>
              <table className="w-full">
                <thead className={GRID_HEADER}>
                  <tr>
                    {["Ticker", "Entry", "Call", "Ask", "Δ", "Exit", "Call ret", "vs Δ-stock"].map((h, i) => (
                      <th key={h} className={cn(GRID_TH, i ? "text-right" : "text-left")}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {picks.map((p, i) => (
                    <tr key={`${p.ticker}-${p.entry}`} className={gridRow(i)}>
                      <td className={GRID_TD}><TickerLink ticker={p.ticker} /></td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{formatMdYy(p.entry)}</td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{p.strike}C {formatMdYy(p.expiry)} <AddToTicket label="+" legs={[{ ticker: p.ticker, kind: "call", side: "long", qty: 1, strike: p.strike, expiry: p.expiry }]} /></td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{px(p.ask)}</td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{p.delta.toFixed(2)}</td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>
                        {p.vsDelta == null ? `grade ${formatMdYy(p.gradeOn)}` : (
                          <DataTip tip={p.exitFill ?? ""}><span>{formatMdYy(p.gradeOn)}</span></DataTip>
                        )}
                      </td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{pct(p.retCall, 0)}</td>
                      <td className={cn(GRID_TD, "text-right tabular-nums font-semibold",
                        p.vsDelta == null ? "text-amber-100" : p.vsDelta > 0 ? "text-emerald-400" : "text-rose-400")}>
                        {pct(p.vsDelta, 0)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

type S172Data = { picks: S171Pick[]; curve: { date: string; ratio: number }[];
  puts: S172Put[] };
type S172Put = { ticker: string; asOf: string; status: string; occ: string | null; entryMid: number | null; ret: number | null;
  hiBeta?: boolean; beta?: number | null; rank?: number | null; cr20?: number | null; cr10?: number | null; strike?: number | null; expiry?: string | null };

/** S173: top-beta fifth on the latest fire — top 20 paper-graded (real contract next session), rest listed with a model credit. */
function HiBetaPuts({ rows }: { rows: S172Put[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, 20);
  return (
    <div className="space-y-0.5">
      <p className="text-amber-100">
        <DataTip tip={"S173 (18 un-invert episodes 2018→, ~930 names, model-priced at each name's own IV): 0.20Δ ~30-day puts on the top-beta fifth earned +3.0 % (2018–22) / +2.0 % (2023→) per $ collateral vs +0.9 / +0.6 % on SPY's put, and beat each name's own any-day put in both halves. Worst single name −29 %, 6–9 % ended in the money.\n\nStructures (S173b, same names, per $ at risk): 0.10Δ put = safer (+1.6 / +1.1 %, worst name −24 %, 2–3 % lose); 0.30Δ = more (+4.3 / +2.6 %) but a losing episode in 2023→. Put spreads: SPY's spread pays as much per $ risk (+14–17 %) → use the index for spreads. Single-name calls did not beat SPY's call → index for calls.\n\n18 episodes = underpowered; paper only. Top 20 get a real contract next session and are graded at expiry; credit columns are model estimates per $ strike for ~30 days."}>
          <span className="underline decoration-dotted cursor-help">High-beta puts (S173, paper) — {rows.length} names</span>
        </DataTip>
        <span className="ml-2 text-amber-100/80">best size: many small, these move together</span>
      </p>
      <table className="w-full text-[11px] tabular-nums">
        <thead><tr className="text-amber-100/80 text-left">
          <th className="pr-2">#</th><th className="pr-2">Ticker</th><th className="pr-2">β</th>
          <th className="pr-2" title="Model credit per $ strike, ~30 days, own IV">0.20Δ credit</th><th className="pr-2">0.10Δ credit</th>
          <th className="pr-2">Contract</th><th>Result</th>
        </tr></thead>
        <tbody>
          {shown.map((p) => (
            <tr key={`hb-${p.ticker}`} className="text-amber-100">
              <td className="pr-2 text-amber-100/80">{p.rank ?? ""}</td>
              <td className="pr-2 font-semibold text-white">{p.ticker}</td>
              <td className="pr-2">{p.beta != null ? p.beta.toFixed(1) : "—"}</td>
              <td className="pr-2">{p.cr20 != null ? pct(p.cr20, 1) : "—"}</td>
              <td className="pr-2">{p.cr10 != null ? pct(p.cr10, 1) : "—"}</td>
              <td className="pr-2">{p.occ ?? (p.status === "open" ? "pricing next session" : "listed")}</td>
              <td className={cn(p.ret == null ? "text-amber-100/80" : p.ret > 0 ? "text-emerald-400" : "text-rose-400")}>{p.ret != null ? pct(p.ret, 1) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 20 ? (
        <button type="button" className="text-[11px] text-[#d4af37] underline" onClick={() => setAll(!all)}>
          {all ? "show top 20" : `show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}

/** S172: VIX÷VIX3M un-invert = market bottom tell (Jamie 11-09). Open by default for 10 days after a fire. */
function BottomSignal({ d }: { d: S172Data }) {
  const last = d.curve[d.curve.length - 1];
  const lastFire = d.picks[0]?.entry ?? d.puts[0]?.asOf ?? null;
  const fresh = lastFire != null && (Date.now() - new Date(lastFire).getTime()) / 864e5 <= 10;
  const [show, setShow] = useState(fresh);
  if (!last) return null;
  const inv = last.ratio >= 1;
  const state = fresh ? `FIRED ${formatMdYy(lastFire!)} — buy index calls / sell puts`
    : inv ? "inverted (panic) — wait for the un-invert" : "normal — no signal";
  return (
    <div className={cn("rounded border bg-zinc-950", fresh ? "border-emerald-400/60" : "border-[#d4af37]/20")}>
      <button type="button" onClick={() => setShow(!show)}
        className="w-full flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1 text-left">
        {show ? <ChevronDown className="w-3 h-3 text-[#d4af37] shrink-0" /> : <ChevronRight className="w-3 h-3 text-[#d4af37] shrink-0" />}
        <DataTip tip={"S172 (2009→, 33–38 episodes per ETF): the first close with VIX÷VIX3M below 1 after ≥ 2 inverted sessions.\n\n0.50Δ ~30-day calls held to expiry beat the same call bought on any day by +34 % (SPY), +43 % (QQQ), +39 % (IWM) per $ debit, both halves 2009–17 / 2018→, placebo p ≤ 0.05. Real LSEG SPY quotes at the ask, 11 episodes 2019→: mean +74 %, 7 of 11 won.\n\n0.20Δ ~30-day short puts after the signal: SPY 95 %, QQQ 94 % win.\n\nFailed (no edge): entering while still inverted (‘early normalizing’), VIX9D÷VIX, a 15 % VIX drop, VVIX peak.\n\nPicks below are paper, entered at the Schwab ask the session the job runs, graded at expiry vs the same-Δ stock."}>
          <span className="font-semibold text-white underline decoration-dotted cursor-help">Market bottom signal: VIX curve un-invert (S172)</span>
        </DataTip>
        <span className={cn("tabular-nums font-semibold", fresh ? "text-emerald-400" : inv ? "text-rose-400" : "text-amber-100")}>
          VIX÷VIX3M {last.ratio.toFixed(2)} · {state}
        </span>
      </button>
      {show ? (
        <div className="px-2 pb-2 space-y-1">
          <p className="tabular-nums text-amber-100">
            Last 10: {d.curve.map((c) => (
              <span key={c.date} className={cn("mr-1.5", c.ratio >= 1 ? "text-rose-400" : "text-white")}>{formatMdYy(c.date)} {c.ratio.toFixed(2)}</span>
            ))}
          </p>
          {d.picks.length ? (
            <div className={GRID_WRAP}>
              <table className="w-full">
                <thead className={GRID_HEADER}>
                  <tr>{["Ticker", "Entry", "Call", "Ask", "Δ", "Grade", "Call ret", "vs Δ-stock"].map((h, i) => (
                    <th key={h} className={cn(GRID_TH, i ? "text-right" : "text-left")}>{h}</th>))}</tr>
                </thead>
                <tbody>
                  {d.picks.map((p, i) => (
                    <tr key={`${p.ticker}-${p.entry}`} className={gridRow(i)}>
                      <td className={GRID_TD}><TickerLink ticker={p.ticker} /></td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{formatMdYy(p.entry)}</td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{p.strike}C {formatMdYy(p.expiry)} <AddToTicket label="+" legs={[{ ticker: p.ticker, kind: "call", side: "long", qty: 1, strike: p.strike, expiry: p.expiry }]} /></td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{px(p.ask)}</td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{p.delta.toFixed(2)}</td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{formatMdYy(p.gradeOn)}</td>
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{pct(p.retCall, 0)}</td>
                      <td className={cn(GRID_TD, "text-right tabular-nums font-semibold",
                        p.vsDelta == null ? "text-amber-100" : p.vsDelta > 0 ? "text-emerald-400" : "text-rose-400")}>{pct(p.vsDelta, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {d.puts.some((p) => !p.hiBeta) ? (
            <p className="text-amber-100">Put signals: {d.puts.filter((p) => !p.hiBeta).map((p) => (
              <span key={`${p.ticker}-${p.asOf}`} className="mr-2">{p.ticker} {formatMdYy(p.asOf)} {p.occ ?? p.status}{p.ret != null ? ` ${pct(p.ret, 1)}` : ""}</span>
            ))}</p>
          ) : null}
          {d.puts.some((p) => p.hiBeta) ? <HiBetaPuts rows={d.puts.filter((p) => p.hiBeta)} /> : null}
        </div>
      ) : null}
    </div>
  );
}

export function LongOptionBoard({ side }: { side?: "call" | "put" } = {}) {
  const { data, isLoading } = useQuery({
    queryKey: ["long-option-board"],
    queryFn: async (): Promise<{ board: Board | null; s171?: S171Pick[]; s171Summary?: S171Summary; s172?: S172Data }> => {
      const r = await fetch("/api/options/long-board", { credentials: "include" });
      if (!r.ok) throw new Error("long-board fetch failed");
      return r.json();
    },
    staleTime: 10 * 60_000,
    refetchInterval: 15 * 60_000,
    refetchOnWindowFocus: true,
  });
  const [open, setOpen] = useState<string | null>("Estimate revisions (S085)");
  if (isLoading) return <p className="text-xs text-amber-100">Loading…</p>;
  const b = data?.board;
  if (!b) return <p className="text-xs text-amber-100">No S086 board yet (morning job).</p>;

  const sides = side ? [side] as const : (["call", "put"] as const);
  const buyAll = side === "put" ? b.buyAll.put : side === "call" ? b.buyAll.call : null;

  return (
    <div className="space-y-1.5 text-xs" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-0.5">
        <span className="text-[#d4af37] font-bold text-[10px] uppercase tracking-wide">
          S086 name angles {side ? `(long ${side})` : ""}
        </span>
        <span className="text-white font-semibold tabular-nums">{formatMdYy(b.asOf)}</span>
        <DataTip tip="Different pipeline from Schwab multi-leg picks: ranks names on weeks like today vs buy-all. Not the same logic as CSP/jade rows.">
          <span className="text-amber-100 underline decoration-dotted cursor-help">≠ A192 fills</span>
        </DataTip>
        {buyAll != null ? (
          <span className="text-amber-100">buy-all {pct(buyAll)}</span>
        ) : (
          <span className="text-amber-100">buy-all calls {pct(b.buyAll.call)} · puts {pct(b.buyAll.put)}</span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-0.5 text-amber-100">
        {sides.map((s) => (
          <span key={s}>
            <span className="text-white font-semibold">{s === "call" ? "Call" : "Put"} overlap:</span>{" "}
            {b.overlap[s].slice(0, 8).map(([t, k]) => `${t} ×${k}`).join(" · ") || "none"}
          </span>
        ))}
      </div>

      {side !== "put" && data?.s172 ? <BottomSignal d={data.s172} /> : null}
      {side !== "put" && data?.s171Summary ? <S171Paper picks={data.s171 ?? []} sum={data.s171Summary} /> : null}

      {b.strategies.map((st) => {
        const isOpen = open === st.name;
        const failing = st.status === "failing forward";
        return (
          <div key={st.name} className="rounded border border-[#d4af37]/20 bg-zinc-950">
            <button type="button" onClick={() => setOpen(isOpen ? null : st.name)}
              className="w-full flex flex-wrap items-center gap-x-2 gap-y-0.5 px-2 py-1 text-left">
              {isOpen ? <ChevronDown className="w-3 h-3 text-[#d4af37] shrink-0" />
                : <ChevronRight className="w-3 h-3 text-[#d4af37] shrink-0" />}
              <span className="font-semibold text-white">{st.name}</span>
              {sides.map((s) => {
                const sideRow = st[s];
                const v = verdict(sideRow, s === "call" ? b.buyAll.call : b.buyAll.put);
                return (
                  <DataTip key={s} tip={`${v.tip}\n\nEdge ${pct(sideRow.edgeAnalog[0], 2)} (t ${sideRow.edgeAnalog[1]?.toFixed(1) ?? "—"}) · option ${pct(sideRow.option[0])} on ${sideRow.option[1]} trades${sideRow.optionUngated != null ? ` · picks limited to names with IV rank below the week's median (buy cheap); without that gate ${pct(sideRow.optionUngated)}` : ""}${sideRow.optionByDte && Object.keys(sideRow.optionByDte).length > 1 ? `\nBy horizon (per trade, held to expiry; buy-all in brackets): ${Object.entries(sideRow.optionByDte).map(([k, v]) => `${k}d ${pct(v, 0)} (${pct(b.buyAllCallByDte?.[k], 0)})`).join(" · ")}` : ""}.`}>
                    <span className="inline-flex items-center gap-1">
                      <span className="text-amber-100">{s === "call" ? "Calls" : "Puts"}</span>
                      <span className={cn("rounded border px-1 text-[10px] uppercase", v.cls)}>{v.label}</span>
                      <span className="tabular-nums text-white">{pct(sideRow.option[0], 0)}</span>
                      {sideRow.optionUngated != null && (
                        <span className="tabular-nums text-amber-100/80 text-[10px]">no gate {pct(sideRow.optionUngated, 0)}</span>
                      )}
                    </span>
                  </DataTip>
                );
              })}
              {st.forward && (!side || side === "call") ? (
                <DataTip tip={failing
                  ? "Demoted vs paper buy-all after 30+ graded trades."
                  : "Forward paper: top-10 calls logged weekly, graded at expiry."}>
                  <span className={cn("tabular-nums", failing ? "text-rose-400" : "text-emerald-400")}>
                    paper {fwdText(st.forward)}{failing ? " · demoted" : ""}
                  </span>
                </DataTip>
              ) : null}
            </button>
            {isOpen ? (
              <div className={cn("grid gap-2 px-2 pb-2", sides.length > 1 && "md:grid-cols-2")}>
                {sides.map((s) => (
                  <div key={s} className="space-y-0.5">
                    <p className="text-[11px] text-amber-100">Long {s}s · exp ~{formatMdYy(b.expiry)}</p>
                    <NamesTable side={s} rows={st[s].names} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
