/**
 * Rankings › Structures (A192). Dense pick board — numbers first, prose in tips only.
 */
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
import { formatMd, formatMdYy } from "@/lib/format";
import { TickerLink } from "@/components/ticker-link";

type Leg = { side: "put" | "call"; strike: number; expiry: string; qty: number; px: number; bid: number; ask: number; iv: number };
type Row = {
  ticker: string; spot: number; expiry: string; dte: number; legs: Leg[]; credit: number; capital: number; max_loss: number | null;
  max_gain: number | null; p_mkt: number; p_rv: number; ev_mkt: number; ev_rv: number; ev_rv_cap: number; worst5?: number; iv_rv: number;
  fit_why: string; edge_q: number | null;
};
type Structure = { id: string; name: string; family: string; description: string; regime: string; evidence: string; evidenceNote: string; rows: Row[] };
type Board = { asOf: string | null; stance: string | null; structures: Structure[] };

// Badge = HISTORICAL verdict for the structure in general (S076 backtest 2021→), not a call on today. Today = the rows.
const BADGE: Record<string, { label: string; cls: string; tip: string }> = {
  pass: { label: "Backtest ✓ works", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    tip: "Historically made money after realistic fills (2021 → backtest). This is about the structure in general, not a signal for today — today's candidates are the rows inside." },
  untested: { label: "Not proven", cls: "bg-amber-500/15 text-amber-200 border-amber-500/30",
    tip: "Backtest promising but not proven (could be luck), or not testable yet. Treat today's rows as ideas, not edges." },
  fail: { label: "Backtest ✕ loses", cls: "bg-red-500/15 text-red-300 border-red-500/30",
    tip: "Historically lost money (or lost to simply selling a cash-secured put) after realistic fills. Shown for reference; never recommended as a pick." },
};

const HEADS: { label: string; tip: string; right?: boolean }[] = [
  { label: "Ticker", tip: "Stock and its price at the morning scan." },
  { label: "Trade (legs)", tip: "Each option in the trade: + = buy, − = sell, strike, P/C = put/call, expiry. Hover a row for bid / ask / your fill." },
  { label: "Credit", right: true, tip: "Money per contract (×100 shares) you collect now (+) or pay (−), at a realistic fill: bid + 23 % of the spread when selling, ask − 23 % when buying (your Robinhood median)." },
  { label: "Capital", right: true, tip: "Money tied up per contract. Cash-secured put = strike × 100. Spreads = the most you can lose. Strangle/straddle = broker margin (~20 % of the stock). Covered call/collar = the 100 shares." },
  { label: "Win odds", right: true, tip: "Chance the trade makes money at expiry, using the option market's own implied volatility. What prices imply, not our forecast." },
  { label: "Expected", right: true, tip: "Average result ÷ capital if the stock moves like it did over its last 2 years (its own real moves, gaps included). Positive = options look overpriced vs how the stock really moves." },
  { label: "Bad case", right: true, tip: "The worst 1-in-20 outcome ÷ capital, from the same 2-year history. −12 % = about 1 time in 20 you lose 12 % of the capital or more." },
  { label: "Why it fits today", tip: "The rule that put this trade on the board today. IV/RV and put-edge rank are explained on hover." },
];

const usd = (v: number | null | undefined) => (v == null ? "—" : `$${Math.abs(v * 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const pct = (v: number | null | undefined, d = 0) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);

function legText(l: Leg): string {
  const side = l.side === "put" ? "P" : "C";
  return `${l.qty > 0 ? "+" : "−"}${l.strike}${side} ${formatMd(l.expiry)}`;
}

/** Emphasize numbers + action verbs in a short stance / why line. */
function accentLine(text: string): ReactNode {
  const parts = text.split(/(\d+(?:\.\d+)?×|\d+(?:\.\d+)?%|IV\/RV\s*\d+(?:\.\d+)?|sell puts|smaller puts|cut new put size)/gi);
  return parts.map((p, i) => {
    if (!p) return null;
    if (/^(sell puts|smaller puts|cut new put size)$/i.test(p)) {
      return <span key={i} className="font-semibold text-[#d4af37]">{p}</span>;
    }
    if (/^\d/.test(p) || /^IV\/RV/i.test(p)) {
      return <span key={i} className="font-mono font-semibold text-white">{p}</span>;
    }
    return <span key={i} className="text-amber-100/70">{p}</span>;
  });
}

function legsTip(r: Row, asOf: string | null): string {
  const lines = r.legs.map((l) => `${l.qty > 0 ? "Buy" : "Sell"} ${l.strike}${l.side === "put" ? "P" : "C"} ${formatMd(l.expiry)} · bid $${l.bid.toFixed(2)} / ask $${l.ask.toFixed(2)} → your fill $${l.px.toFixed(2)} · IV ${(l.iv * 100).toFixed(0)} %`);
  return [...lines, "", `Source: Schwab option chain, morning scan ${asOf ? formatMd(asOf) : ""}. Fill = bid + 23 % of the spread when selling (ask − 23 % when buying).`].join("\n");
}

function capitalTip(id: string, r: Row): string {
  if (id === "csp") return `Cash held to buy 100 shares at the ${r.legs[0]?.strike} strike if assigned = ${usd(r.capital)}.`;
  if (id === "covered_call" || id === "collar") return `The 100 shares you hold ≈ ${usd(r.capital)}.`;
  if (id === "short_strangle" || id === "short_straddle") return `Broker margin ≈ 20 % of the stock + the credit = ${usd(r.capital)}. Undefined risk: losses can exceed this. Margin account only (not the IRA).`;
  return `The most you can lose on this trade = ${usd(r.capital)} per contract.`;
}

function whyTip(r: Row): string {
  const out = [`${r.dte} days to expiry.`];
  if (r.iv_rv != null) out.push(`IV/RV ${r.iv_rv.toFixed(2)}: the volatility option prices imply ÷ how much ${r.ticker} actually moved over the last 20 days. Above 1 = options are priced richer than the stock has been moving (good for selling); below 1 = cheap (good for buying).`);
  if (r.edge_q != null) out.push(`Put edge Q${r.edge_q}: this week's rank on our put-edge score (IV/RV + volatility-of-volatility + put technicals, study S059). Q5 = top 20 % of names (historically the best puts to sell), Q1 = bottom 20 % (lose after fills).`);
  return out.join("\n\n");
}

export function StructuresBoard() {
  const { data, isLoading } = useQuery({
    queryKey: ["options-structures"],
    queryFn: async (): Promise<Board> => {
      const r = await fetch("/api/options/structures", { credentials: "include" });
      if (!r.ok) throw new Error("structures fetch failed");
      return r.json();
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (isLoading) return <p className="text-xs text-amber-100">Loading…</p>;
  if (!data?.structures.length) return <p className="text-xs text-amber-100">No board yet (morning job).</p>;

  const withPicks = data.structures.filter((s) => s.rows.length > 0);
  const pickN = withPicks.reduce((n, s) => n + s.rows.length, 0);
  const toggle = (id: string) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  return (
    <div className="space-y-1.5 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-0.5">
        <span className="text-[#d4af37] font-bold tabular-nums">{formatMdYy(data.asOf)}</span>
        <span className="text-white font-semibold tabular-nums">{pickN} picks</span>
        <span className="text-amber-100/50">{withPicks.length} structures</span>
      </div>
      <p className="text-[11px] leading-snug px-0.5 text-amber-100/70">
        Each option structure, with <span className="text-white">today's candidate trades</span> inside (real Schwab prices, realistic fills).
        The badge is the <span className="text-white">historical backtest verdict</span> for the structure in general, not a call on today.
        Hover any number for what it means; details per structure in the Backtest lab below.
      </p>
      {data.stance ? (
        <p className="text-[11px] leading-snug px-0.5">{accentLine(data.stance)}</p>
      ) : null}

      {data.structures.map((s) => {
        const b = BADGE[s.evidence] ?? BADGE.untested;
        const isOpen = (s.rows.length > 0) !== open.has(s.id);
        const metaTip = [s.description, s.regime ? `When: ${s.regime}` : null, s.evidenceNote ? `Evidence: ${s.evidenceNote}` : null]
          .filter(Boolean)
          .join("\n");
        return (
          <div key={s.id} className="rounded border border-[#d4af37]/20 bg-zinc-950">
            <button type="button" onClick={() => toggle(s.id)} className="w-full flex items-center gap-1.5 px-2 py-1 text-left">
              {isOpen
                ? <ChevronDown className="w-3 h-3 text-[#d4af37] shrink-0" />
                : <ChevronRight className="w-3 h-3 text-[#d4af37] shrink-0" />}
              <DataTip tip={metaTip}>
                <span className="font-semibold text-white">{s.name}</span>
              </DataTip>
              <DataTip tip={`${b.tip}${s.evidenceNote ? `\n\n${s.evidenceNote}` : ""}`}>
                <span className={cn("px-1 rounded border text-[9px] font-bold uppercase tracking-wide", b.cls)}>
                  {b.label}
                </span>
              </DataTip>
              <span className={cn(
                "ml-auto tabular-nums font-mono text-[11px]",
                s.rows.length ? "text-white font-bold" : "text-amber-100/40",
              )}>
                {s.rows.length || "—"}
              </span>
            </button>
            {isOpen && s.rows.length > 0 && (
              <div className="px-1.5 pb-1.5">
                <div className={GRID_WRAP}>
                  <table className="w-full border-collapse">
                    <thead>
                      <tr className={GRID_HEADER}>
                        {HEADS.map((h) => (
                          <th key={h.label} className={cn(GRID_TH, h.right ? "text-right" : "text-left")}>
                            <DataTip tip={h.tip}>{h.label}</DataTip>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {s.rows.map((r, i) => (
                        <tr key={r.ticker} className={gridRow(i)}>
                          <td className={cn(GRID_TD, "font-mono")}>
                            <TickerLink ticker={r.ticker} returnLabel="Structures" />
                            <span className="text-amber-100/50 ml-1">${r.spot.toFixed(0)}</span>
                          </td>
                          <td className={cn(GRID_TD, "text-amber-50 font-mono text-[10px]")}>
                            <DataTip tip={legsTip(r, data.asOf)}>{r.legs.map(legText).join(" · ")}</DataTip>
                          </td>
                          <td className={cn(GRID_TD, "text-right font-mono font-semibold", r.credit >= 0 ? "text-emerald-300" : "text-red-300")}>
                            <DataTip tip={r.credit >= 0
                              ? `You collect ${usd(r.credit)} now per contract (all legs at realistic fills). It's yours to keep if the trade ends worthless.`
                              : `You pay ${usd(r.credit)} now per contract. That's the most a pure option buy can lose.`}>
                              {r.credit >= 0 ? "+" : "−"}{usd(r.credit)}
                            </DataTip>
                          </td>
                          <td className={cn(GRID_TD, "text-right font-mono text-amber-50")}>
                            <DataTip tip={capitalTip(s.id, r)}>{usd(r.capital)}</DataTip>
                          </td>
                          <td className={cn(GRID_TD, "text-right font-mono text-white")}>
                            <DataTip tip={`${pct(r.p_mkt)} chance this ends with a profit at expiry (${formatMd(r.expiry)}), using the market's own implied volatility. A pricing-implied probability, not our forecast.`}>
                              {pct(r.p_mkt)}
                            </DataTip>
                          </td>
                          <td className={cn(GRID_TD, "text-right font-mono font-bold", (r.ev_rv_cap ?? 0) >= 0 ? "text-emerald-300" : "text-red-300")}>
                            <DataTip tip={`If ${r.ticker} moves like its last 2 years of real ${r.dte}-day moves (earnings gaps included), the average result is ${pct(r.ev_rv_cap, 1)} of the capital ≈ ${(r.ev_rv ?? 0) >= 0 ? "+" : "−"}${usd(r.ev_rv)} per contract.`}>
                              {pct(r.ev_rv_cap, 1)}
                            </DataTip>
                          </td>
                          <td className={cn(GRID_TD, "text-right font-mono text-red-300")}>
                            <DataTip tip={r.worst5 == null ? null : `About 1 time in 20 (from the same 2-year history) this trade loses ${pct(Math.abs(r.worst5), 0)} of the ${usd(r.capital)} capital or more ≈ ${usd(Math.abs(r.worst5) * r.capital)} per contract.`}>
                              {pct(r.worst5, 0)}
                            </DataTip>
                          </td>
                          <td className={cn(GRID_TD, "text-[11px] leading-snug")}>
                            <DataTip tip={whyTip(r)}>
                              <span className="text-[#d4af37]/80 font-mono mr-1">{r.dte}d</span>
                              {accentLine(r.fit_why)}
                            </DataTip>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {isOpen && s.rows.length === 0 && (
              <p className="px-2 pb-1.5 text-[10px] text-amber-100/40">
                No trade today — today's market doesn't match when this structure fits{s.evidence === "fail" ? ", and it lost in the backtest" : ""}. Hover the name for when it fits.
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
