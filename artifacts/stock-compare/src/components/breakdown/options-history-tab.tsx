/**
 * Breakdown › Options history (Claude, PM role, user 2026-10-14). Headline numbers only; method lives in ⓘ tooltips (user rule).
 * Data: GET /api/stocks/:ticker/options-history (earnings moves, IV) + GET /api/pm/trades/:ticker (admin: your puts).
 * Written by scripts/watchlist_sync/analysis/option_derive.py from Polygon end-of-day option prices (schema optlab).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart,
  Tooltip as RTooltip, XAxis, YAxis, ZAxis,
} from "recharts";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Move = { date: string; implied: number; realized: number; ratio: number | null };
type Iv = { date: string; iv: number; rv20: number | null; ivRank: number | null };
type Trade = {
  key: string; account: string; d0: string; expiry: string; strike: number; premium: number; qty: number;
  breached: boolean; closedEarly: boolean; path: { date: string; c: number }[];
};

const GOLD = "#d4af37";
const TIP = "bg-zinc-950 border border-[#d4af37]/30 text-[11px]";
const pct = (x: number | null | undefined, d = 0) => (x == null ? "—" : `${(x * 100).toFixed(d)}%`);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

function Info_({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button type="button" className="text-amber-200/40 hover:text-amber-200/80"><Info className="w-3 h-3" /></button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[300px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

function Head({ title, value, sub, info }: { title: string; value: React.ReactNode; sub?: React.ReactNode; info: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 text-[11px]">
      <span className="text-amber-200/60 uppercase tracking-wide text-[10px]">{title}</span>
      <span className="text-[15px] font-semibold tabular-nums text-amber-100">{value}</span>
      {sub && <span className="text-amber-200/60">{sub}</span>}
      <span className="ml-auto"><Info_>{info}</Info_></span>
    </div>
  );
}

function useJson<T>(key: unknown[], url: string, enabled = true) {
  return useQuery({
    queryKey: key,
    enabled,
    queryFn: async (): Promise<T> => {
      const r = await fetch(url, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 30 * 60_000,
  });
}

function EarningsMoves({ moves }: { moves: Move[] }) {
  const m = median(moves.map((x) => x.ratio).filter((x): x is number => x != null));
  const beat = moves.filter((x) => x.realized > x.implied).length;
  return (
    <div className="space-y-1">
      <Head
        title="Earnings moves"
        value={m == null ? "—" : `${m.toFixed(1)}×`}
        sub={m == null ? "no reports yet" : <>priced move · bigger than priced {beat}/{moves.length}</>}
        info={<>Priced-in move = at-the-money straddle (put + call, first weekly expiry after the report) at the close before ÷ stock price.
          Actual = first close after the report vs last close before. Below 1× = options overpriced the move (sellers won).
          Per-name conclusions wait for study S018 (needs ≥ 4 reports and a persistence test).</>}
      />
      {moves.length > 0 && (
        <ResponsiveContainer width="100%" height={110}>
          <BarChart data={moves.slice(-8).map((x) => ({ ...x, label: x.date.slice(2, 7) }))} barGap={1}>
            <XAxis dataKey="label" tick={{ fontSize: 9, fill: "#a1a1aa" }} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => pct(v)} tick={{ fontSize: 9, fill: "#a1a1aa" }} width={32} axisLine={false} tickLine={false} />
            <RTooltip contentStyle={{ background: "#09090b", border: "1px solid #d4af3755", fontSize: 11 }}
              formatter={(v: number, n: string) => [pct(v, 1), n === "implied" ? "priced" : "actual"]} labelFormatter={(_, p) => p?.[0]?.payload?.date ?? ""} />
            <Bar dataKey="implied" fill="#52525b" radius={[2, 2, 0, 0]} />
            <Bar dataKey="realized" radius={[2, 2, 0, 0]}>
              {moves.slice(-8).map((x) => <Cell key={x.date} fill={x.realized > x.implied ? "#f87171" : GOLD} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function ImpliedVol({ iv }: { iv: Iv[] }) {
  const last = iv[iv.length - 1];
  return (
    <div className="space-y-1">
      <Head
        title="Implied vol"
        value={last ? pct(last.iv) : "—"}
        sub={last ? <>rank {last.ivRank == null ? "—" : Math.round(last.ivRank * 100)} · realized {pct(last.rv20)}</> : "book names first; others as data loads"}
        info={<>~30-day implied vol from the near-the-money monthly put's closing price (Black-Scholes). Rank = where today sits in the past
          year (0 = lowest, 100 = highest). Realized = last 20 trading days. The gap between the lines is what option sellers are paid.
          Fildi's current "IV rank" elsewhere is a realized-vol rank; study S019 tests whether this one predicts better.</>}
      />
      {iv.length > 0 && (
        <ResponsiveContainer width="100%" height={110}>
          <LineChart data={iv}>
            <CartesianGrid stroke="#27272a" vertical={false} />
            <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(2, 7)} tick={{ fontSize: 9, fill: "#a1a1aa" }} minTickGap={40} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v) => pct(v)} tick={{ fontSize: 9, fill: "#a1a1aa" }} width={32} axisLine={false} tickLine={false} />
            <RTooltip contentStyle={{ background: "#09090b", border: "1px solid #d4af3755", fontSize: 11 }}
              formatter={(v: number, n: string) => [pct(v, 1), n === "iv" ? "implied" : "realized"]} />
            <Line dataKey="iv" stroke={GOLD} dot={false} strokeWidth={1.5} />
            <Line dataKey="rv20" stroke="#71717a" dot={false} strokeWidth={1} />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

function YourPuts({ trades }: { trades: Trade[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const pts = useMemo(() => trades.map((t) => ({
    ...t, x: new Date(t.d0).getTime(), y: t.premium * t.qty * 100,
    color: t.breached ? "#f87171" : t.closedEarly ? "#a1a1aa" : "#34d399",
  })), [trades]);
  const kept = trades.filter((t) => !t.breached).length;
  const prem = pts.reduce((s, p) => s + p.y, 0);
  const cur = trades.find((t) => t.key === sel);
  return (
    <div className="space-y-1">
      <Head
        title="Your puts"
        value={trades.length}
        sub={<>{kept} kept · {trades.length - kept} breached · ${Math.round(prem).toLocaleString()} premium</>}
        info={<>Every put you sold on this name (Robinhood history, S015). Dot = entry date × premium collected; green = expired worthless,
          red = finished in the money, gray = you bought it back. Click a dot for the option's daily closing price until expiry.
          Gold line = your premium, dashed = 50 % of it (the take-profit level study S017 is testing).</>}
      />
      {trades.length === 0 ? <p className="text-[10px] text-amber-200/40 italic">No puts on this name.</p> : (
        <ResponsiveContainer width="100%" height={110}>
          <ScatterChart>
            <XAxis dataKey="x" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(v: number) => new Date(v).toISOString().slice(5, 10)}
              tick={{ fontSize: 9, fill: "#a1a1aa" }} axisLine={false} tickLine={false} />
            <YAxis dataKey="y" tickFormatter={(v: number) => `$${Math.round(v)}`} tick={{ fontSize: 9, fill: "#a1a1aa" }} width={40} axisLine={false} tickLine={false} />
            <ZAxis range={[28, 28]} />
            <RTooltip contentStyle={{ background: "#09090b", border: "1px solid #d4af3755", fontSize: 11 }}
              content={({ payload }) => {
                const p = payload?.[0]?.payload as (Trade & { y: number }) | undefined;
                return p ? <div className={cn(TIP, "px-2 py-1 text-zinc-100")}>{p.account} · {p.strike}P exp {p.expiry}<br />${p.premium.toFixed(2)} × {p.qty} = ${Math.round(p.y)}</div> : null;
              }} />
            <Scatter data={pts} onClick={(p: { key?: string }) => setSel(p.key ?? null)} cursor="pointer">
              {pts.map((p) => <Cell key={p.key} fill={p.color} stroke={p.key === sel ? GOLD : "none"} />)}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      )}
      {cur && (
        <div className="rounded border border-[#d4af37]/20 p-1.5">
          <div className="text-[10px] text-amber-200/70">{cur.strike}P {cur.expiry} · sold {cur.d0} at ${cur.premium.toFixed(2)}
            {cur.path.length === 0 && " · price history still loading"}</div>
          {cur.path.length > 0 && (
            <ResponsiveContainer width="100%" height={90}>
              <LineChart data={cur.path}>
                <XAxis dataKey="date" tickFormatter={(d: string) => d.slice(5)} tick={{ fontSize: 9, fill: "#a1a1aa" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: "#a1a1aa" }} width={32} axisLine={false} tickLine={false} />
                <RTooltip contentStyle={{ background: "#09090b", border: "1px solid #d4af3755", fontSize: 11 }} formatter={(v: number) => [`$${v.toFixed(2)}`, "close"]} />
                <ReferenceLine y={cur.premium} stroke={GOLD} />
                <ReferenceLine y={cur.premium / 2} stroke={GOLD} strokeDasharray="3 3" />
                <Line dataKey="c" stroke="#e4e4e7" dot={{ r: 1.5 }} strokeWidth={1.2} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  );
}

export function OptionsHistoryTab({ ticker, isAdmin }: { ticker: string; isAdmin: boolean }) {
  const hist = useJson<{ earnings: Move[]; iv: Iv[] }>(["options-history", ticker], `/api/stocks/${encodeURIComponent(ticker)}/options-history`);
  const mine = useJson<{ trades: Trade[] }>(["pm-trades", ticker], `/api/pm/trades/${encodeURIComponent(ticker)}`, isAdmin);
  if (hist.isLoading) return <p className="text-[10px] text-amber-200/40">Loading…</p>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <EarningsMoves moves={hist.data?.earnings ?? []} />
      <ImpliedVol iv={hist.data?.iv ?? []} />
      {isAdmin && <div className="md:col-span-2"><YourPuts trades={mine.data?.trades ?? []} /></div>}
    </div>
  );
}
