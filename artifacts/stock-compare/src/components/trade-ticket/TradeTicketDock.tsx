/**
 * Trade ticket dock — multi-leg, multi-stock payoff (legs come from Bid/Ask buttons on option rows).
 * Math: lib/trade-ticket.ts (tested). Store: lib/trade-ticket-store.ts. Betas: GET /api/options/betas.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis, ReferenceLine, CartesianGrid,
} from "recharts";
import { X, Minus, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { ticket, useTicket } from "@/lib/trade-ticket-store";
import {
  dollarDeltaPer1Pct, firstExpiryMs, moveGrid, netCost, ticketCurve, ticketSummary, tickersOf, spotAt,
  type TicketLeg,
} from "@/lib/trade-ticket";

const DAY_MS = 86_400_000;
const LINE_COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fb923c", "#a78bfa", "#facc15", "#22d3ee", "#f87171"];
const RANGES = [0.1, 0.2, 0.4] as const;

const usd = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (m: number) => `${m > 0 ? "+" : m < 0 ? "−" : ""}${Math.abs(m * 100).toFixed(1)}%`;
const strikeTxt = (k?: number) => (k == null ? "" : Number.isInteger(k) ? String(k) : k.toFixed(1));

function legLabel(l: TicketLeg): string {
  if (l.kind === "stock") return "shares";
  return `${strikeTxt(l.strike)}${l.kind === "call" ? "C" : "P"} ${l.expiry?.slice(5) ?? ""}`;
}

export function TradeTicketDock() {
  const { legs, open } = useTicket();
  const tickers = useMemo(() => tickersOf(legs), [legs]);
  const [useBeta, setUseBeta] = useState(true);
  const [range, setRange] = useState<(typeof RANGES)[number]>(0.2);
  const [dayFrac, setDayFrac] = useState(0); // 0 = today … 1 = first expiry

  const betaQ = useQuery({
    queryKey: ["options-betas", tickers.join(",")],
    queryFn: async () => {
      const r = await fetch(`/api/options/betas?tickers=${encodeURIComponent(tickers.join(","))}`, { credentials: "include" });
      if (!r.ok) throw new Error("betas failed");
      return (await r.json()) as { betas: Record<string, number | null> };
    },
    enabled: open && useBeta && tickers.length > 1,
    staleTime: 6 * 60 * 60 * 1000,
  });

  // One name → chart its own move; beta only matters when names must share one axis.
  const multi = tickers.length > 1;
  const betas = useMemo(() => {
    const out: Record<string, number> = {};
    if (!useBeta || !multi) return out;
    for (const t of tickers) out[t] = betaQ.data?.betas[t] ?? 1;
    return out;
  }, [useBeta, multi, tickers, betaQ.data]);

  const model = useMemo(() => {
    if (!open || !legs.length) return null;
    const now = Date.now();
    const exp = firstExpiryMs(legs);
    const atMs = exp != null ? now + (exp - now) * dayFrac : now;
    const grid = moveGrid(-range, range, 121);
    const atExp = ticketCurve(legs, grid, exp ?? now, betas);
    const atDate = ticketCurve(legs, grid, atMs, betas);
    const rows = grid.map((m, i) => {
      const r: Record<string, number> = { move: m * 100, expiry: atExp[i].total, date: atDate[i].total };
      if (tickers.length > 1) for (const t of tickers) r[`t_${t}`] = atExp[i].byTicker[t] ?? 0;
      return r;
    });
    return {
      rows, exp, atMs,
      summary: ticketSummary(legs, betas, now),
      delta: dollarDeltaPer1Pct(legs, betas, now),
    };
  }, [open, legs, betas, range, dayFrac, tickers]);

  if (!legs.length) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => ticket.setOpen(true)}
        className="fixed bottom-4 left-4 z-40 rounded-md border border-[#d4af37]/60 bg-black/90 px-3 py-1.5 text-xs text-[#fef3c7] shadow-lg hover:bg-zinc-900"
        title="Open the trade ticket payoff"
      >
        Ticket · {legs.length} leg{legs.length > 1 ? "s" : ""} · {usd(netCost(legs))} {netCost(legs) >= 0 ? "debit" : "credit"}
      </button>
    );
  }

  const s = model?.summary;
  const cost = s?.cost ?? 0;
  const single = tickers.length === 1 ? legs[0] : null;
  const daysToExp = model?.exp != null ? Math.max(0, (model.exp - Date.now()) / DAY_MS) : 0;
  const daysAt = model?.exp != null ? Math.round(((model.atMs - Date.now()) / DAY_MS)) : 0;
  const addShares = (t: string) => {
    const ref = legs.find((l) => l.ticker === t)!;
    ticket.add({ ticker: t, kind: "stock", side: "long", qty: 100, price: ref.spot, spot: ref.spot });
  };

  return (
    <div className="fixed bottom-4 left-4 z-40 w-[600px] max-w-[calc(100vw-32px)] max-h-[85vh] overflow-y-auto rounded-md border border-[#d4af37]/50 bg-black/95 p-2 text-xs text-amber-100 shadow-2xl">
      <div className="mb-1 flex items-center gap-2">
        <span className="font-semibold text-[#d4af37]">Trade ticket</span>
        <span>{legs.length} leg{legs.length > 1 ? "s" : ""} · {tickers.join(", ")}</span>
        <span className="ml-auto" />
        <button type="button" className="text-amber-200/70 hover:text-red-300" onClick={() => ticket.clear()} title="Remove every leg">Clear</button>
        <button type="button" className="text-amber-200/70 hover:text-white" onClick={() => ticket.setOpen(false)} title="Minimise"><X className="h-3.5 w-3.5" /></button>
      </div>

      {/* 1 — the numbers that decide the trade */}
      {s ? (
        <div className="mb-1.5 grid grid-cols-3 gap-x-3 gap-y-0.5 sm:grid-cols-6">
          <Stat label={cost >= 0 ? "Debit" : "Credit"} value={usd(Math.abs(cost))} tip="Net paid (ask on buys) or received (bid on sells)." />
          <Stat label="Max gain" value={s.maxGain == null ? "unlimited" : usd(s.maxGain)} good tip="At the first expiry; later legs keep time value (BS at leg IV)." />
          <Stat label="Max loss" value={s.maxLoss == null ? "unlimited" : usd(s.maxLoss)} bad tip="At the first expiry, across −100 % … +300 % moves." />
          <Stat
            label="Breakeven"
            value={s.breakevens.length
              ? s.breakevens.slice(0, 3).map((b) => single ? `$${spotAt(single, b, betas[single.ticker] ?? 1).toFixed(2)}` : pct(b)).join(" · ")
              : "—"}
            tip={single ? "Underlying price at the first expiry." : "Market move at the first expiry (each name moves beta × it)."}
          />
          <Stat label={multi ? "$ / 1 % mkt" : `$ / 1 % ${tickers[0]}`} value={usd(model!.delta)}
            tip={multi ? "P&L today for a 1 % market move (beta-weighted delta)." : "P&L today for a 1 % move in the stock (delta in $)."} />
          <Stat label="Expiry" value={model?.exp != null ? `${daysToExp.toFixed(0)} d` : "stock only"} tip="Days to the first option expiry." />
        </div>
      ) : null}

      {/* 2 — payoff chart */}
      {model ? (
        <>
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={model.rows} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#27272a" strokeDasharray="2 4" />
                <XAxis dataKey="move" type="number" domain={["dataMin", "dataMax"]} tick={{ fontSize: 9, fill: "#d4d4d8" }}
                  tickFormatter={(v: number) => `${v > 0 ? "+" : ""}${v.toFixed(0)}%`} />
                <YAxis tick={{ fontSize: 9, fill: "#d4d4d8" }} width={56} tickFormatter={(v: number) => usd(v)} />
                <ReferenceLine y={0} stroke="#71717a" />
                <ReferenceLine x={0} stroke="#52525b" strokeDasharray="3 3" />
                <RTooltip
                  contentStyle={{ fontSize: 10, background: "#09090b", border: "1px solid #3f3f46" }}
                  labelFormatter={(v: number) => {
                    const m = v / 100;
                    const px = tickers.map((t) => {
                      const ref = legs.find((l) => l.ticker === t)!;
                      return `${t} $${spotAt(ref, m, betas[t] ?? 1).toFixed(2)}`;
                    }).join(" · ");
                    return multi ? `${useBeta ? "SPY" : "Each name"} ${pct(m)} → ${px}` : `${pct(m)} → ${px}`;
                  }}
                  formatter={(v: number, name: string) => [usd(v), name]}
                />
                {tickers.length > 1 && tickers.map((t, i) => (
                  <Line key={t} type="linear" dataKey={`t_${t}`} name={`${t} at expiry`} stroke={LINE_COLORS[i % LINE_COLORS.length]}
                    dot={false} strokeWidth={1} strokeOpacity={0.7} isAnimationActive={false} />
                ))}
                <Line type="linear" dataKey="date" name={daysAt <= 0 ? "Today" : `In ${daysAt} d`} stroke="#e4e4e7"
                  strokeDasharray="4 3" dot={false} strokeWidth={1.25} isAnimationActive={false} />
                <Line type="linear" dataKey="expiry" name="At first expiry" stroke="#d4af37" dot={false} strokeWidth={2} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* chart controls */}
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-amber-200/70">Range</span>
            {RANGES.map((r) => (
              <button key={r} type="button" onClick={() => setRange(r)}
                className={cn("rounded px-1.5", r === range ? "bg-[#d4af37]/25 text-white" : "text-amber-200/70 hover:text-white")}>
                ±{r * 100}%
              </button>
            ))}
            {multi ? (
              <>
                <span className="ml-2 text-amber-200/70">X axis</span>
                <button type="button" onClick={() => setUseBeta(true)} title="X = SPY move; each name moves its 120-d beta × it"
                  className={cn("rounded px-1.5", useBeta ? "bg-[#d4af37]/25 text-white" : "text-amber-200/70 hover:text-white")}>SPY (beta)</button>
                <button type="button" onClick={() => setUseBeta(false)} title="X = one move applied to every name"
                  className={cn("rounded px-1.5", !useBeta ? "bg-[#d4af37]/25 text-white" : "text-amber-200/70 hover:text-white")}>same %</button>
              </>
            ) : <span className="ml-2 text-amber-200/70">X axis = {tickers[0]} move</span>}
            {model.exp != null ? (
              <label className="ml-auto flex items-center gap-1" title="Dashed line date: today → first expiry">
                <span className="text-amber-200/70">Date</span>
                <input type="range" min={0} max={1} step={0.02} value={dayFrac}
                  onChange={(e) => setDayFrac(Number(e.target.value))} className="w-24 accent-[#d4af37]" />
                <span className="w-10 tabular-nums text-white">{daysAt <= 0 ? "today" : `+${daysAt} d`}</span>
              </label>
            ) : null}
          </div>
          {useBeta && multi ? (
            <div className="mt-0.5 text-amber-200/60">
              Beta {tickers.map((t) => `${t} ${(betas[t] ?? 1).toFixed(2)}${betaQ.data && betaQ.data.betas[t] == null ? "*" : ""}`).join(" · ")}
              {betaQ.data && tickers.some((t) => betaQ.data!.betas[t] == null) ? " (* no history → 1)" : ""}
            </div>
          ) : null}
        </>
      ) : null}

      {/* 3 — legs */}
      <div className={cn(GRID_WRAP, "mt-1.5 overflow-x-auto")}>
        <table className="w-full min-w-[480px] border-collapse">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={GRID_TH}>Ticker</th>
              <th className={GRID_TH}>Side</th>
              <th className={GRID_TH}>Qty</th>
              <th className={GRID_TH}>Contract</th>
              <th className={GRID_TH} title="Your fill per share: ask on buys, bid on sells">Fill</th>
              <th className={GRID_TH} title="Underlying price when added">Spot</th>
              <th className={GRID_TH} />
            </tr>
          </thead>
          <tbody>
            {legs.map((l, i) => (
              <tr key={l.id} className={gridRow(i)}>
                <td className={cn(GRID_TD, "font-mono text-white")}>{l.ticker}</td>
                <td className={GRID_TD}>
                  <button type="button" title="Flip buy / sell (fill price stays — re-add from the chain for the other side's quote)"
                    onClick={() => ticket.update(l.id, { side: l.side === "long" ? "short" : "long" })}
                    className={cn("rounded px-1.5 font-semibold", l.side === "long" ? "bg-emerald-900/50 text-emerald-300" : "bg-red-900/50 text-red-300")}>
                    {l.side === "long" ? "Buy" : "Sell"}
                  </button>
                </td>
                <td className={GRID_TD}>
                  <span className="inline-flex items-center gap-1">
                    <button type="button" aria-label="Less" className="text-amber-200/70 hover:text-white"
                      onClick={() => ticket.update(l.id, { qty: Math.max(1, l.qty - (l.kind === "stock" ? 100 : 1)) })}><Minus className="h-3 w-3" /></button>
                    <span className="w-8 text-center font-mono text-white tabular-nums">{l.qty}</span>
                    <button type="button" aria-label="More" className="text-amber-200/70 hover:text-white"
                      onClick={() => ticket.update(l.id, { qty: l.qty + (l.kind === "stock" ? 100 : 1) })}><Plus className="h-3 w-3" /></button>
                  </span>
                </td>
                <td className={cn(GRID_TD, "font-mono text-white")}>{legLabel(l)}</td>
                <td className={cn(GRID_TD, "font-mono tabular-nums")}>${l.price.toFixed(2)}</td>
                <td className={cn(GRID_TD, "font-mono tabular-nums")}>${l.spot.toFixed(2)}</td>
                <td className={GRID_TD}>
                  <button type="button" aria-label="Remove leg" className="text-amber-200/60 hover:text-red-300" onClick={() => ticket.remove(l.id)}>
                    <Trash2 className="h-3 w-3" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-amber-200/70">
        {tickers.map((t) => (
          <button key={t} type="button" className="text-[#d4af37] hover:text-white" onClick={() => addShares(t)}
            title={`Add 100 ${t} shares at the spot when its first leg was added`}>+100 {t} sh</button>
        ))}
        <span className="ml-auto" title="Re-tapping the same Bid / Ask adds 1 contract and refreshes that leg's fill to the latest quote">
          {(() => {
            const ageMin = (Date.now() - Math.min(...legs.map((l) => l.addedAt))) / 60_000;
            const age = ageMin < 60 ? `${Math.round(ageMin)} min` : ageMin < 2880 ? `${Math.round(ageMin / 60)} h` : `${Math.round(ageMin / 1440)} d`;
            return <span className={ageMin > 60 ? "text-amber-300" : undefined}>Oldest fill {age} old</span>;
          })()} · add legs with Bid / Ask on option rows
        </span>
      </div>
    </div>
  );
}

function Stat({ label, value, tip, good, bad }: { label: string; value: string; tip: string; good?: boolean; bad?: boolean }) {
  return (
    <div title={tip}>
      <div className="text-[10px] uppercase tracking-wide text-amber-200/60">{label}</div>
      <div className={cn("font-mono font-semibold tabular-nums", good ? "text-emerald-300" : bad ? "text-red-300" : "text-white")}>{value}</div>
    </div>
  );
}
