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
                      <td className={cn(GRID_TD, "text-right tabular-nums")}>{p.strike}C {formatMdYy(p.expiry)}</td>
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

export function LongOptionBoard({ side }: { side?: "call" | "put" } = {}) {
  const { data, isLoading } = useQuery({
    queryKey: ["long-option-board"],
    queryFn: async (): Promise<{ board: Board | null; s171?: S171Pick[]; s171Summary?: S171Summary }> => {
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
