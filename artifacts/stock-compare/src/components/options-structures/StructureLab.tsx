/**
 * Rankings › Structures › Backtest lab (S076). Per-structure results from the 2021→ backtest.
 */
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceDot, ReferenceLine,
  ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
import { formatMdYy } from "@/lib/format";

type Sum = {
  n: number; mean: number; median: number; win: number; worst5: number; worst1: number; best5: number; t: number;
  days: number; scen: { base: number; rich: number; cheap: number };
  sd?: number; sharpe?: number; per_stock?: number;   // same-risk view: mean ÷ sd, and return per $ of stock exposure
} | null;
type Verdict = "works" | "promising" | "fails" | "untested";
type Leg = { side: "put" | "call"; strike: number; qty: number; px: number; dte: number };
type S = {
  id: string; name: string; family: string; description: string; verdict: Verdict; why: string;
  as_shown: Sum; all: Sum;
  eras: Record<string, Sum>;
  regimes: Record<string, { n: number; mean: number; win: number; worst5: number }>;
  equity: { m: string; ret: number; cum: number; n: number }[];
  hist: { lo: number; w: number; counts: number[] };
  template: { spot: number; iv: number; dte: number; credit: number; capital?: number; stock: boolean; legs: Leg[] } | null;
  method: string;
};
type Resp = { asOf: string | null; structures: S[] };

const ERA_KEYS = ["2021–23", "2024 →"] as const;
const per100 = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v * 100).toFixed(2)}`;

const GOLD = "#d4af37", GAIN = "#12a37a", LOSS = "#ef4444", AXIS = "#71717a", GRID = "#27272a", TXT = "#a1a1aa";
const AXIS_TICK = { fill: TXT, fontSize: 10 };
const TIP_STYLE = { background: "#09090b", border: "1px solid rgba(212,175,55,0.4)", fontSize: 11, color: "#fef3c7" };

const CHIP: Record<Verdict, { icon: string; label: string; cls: string }> = {
  works: { icon: "✓", label: "Works", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  promising: { icon: "◐", label: "Promising", cls: "bg-amber-500/15 text-amber-200 border-amber-500/30" },
  fails: { icon: "✕", label: "Fails", cls: "bg-red-500/15 text-red-300 border-red-500/30" },
  untested: { icon: "·", label: "Untested", cls: "bg-zinc-500/15 text-zinc-300 border-zinc-500/30" },
};

const fin = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const spct = (v: number | null | undefined, d = 1) =>
  !fin(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(d)} %`;
const upct = (v: number | null | undefined, d = 0) => (!fin(v) ? "—" : `${(v * 100).toFixed(d)} %`);
const tone = (v: number | null | undefined) => (!fin(v) || v === 0 ? "text-white" : v > 0 ? "text-emerald-300" : "text-red-300");
const primary = (s: S): Sum => s.as_shown ?? s.all;
const barValue = (s: S): number | undefined => primary(s)?.sharpe ?? primary(s)?.mean;

function Chip({ s }: { s: S }) {
  const c = CHIP[s.verdict] ?? CHIP.untested;
  return (
    <DataTip tip={s.why || null}>
      <span className={cn("px-1 rounded border text-[9px] font-bold uppercase tracking-wide whitespace-nowrap", c.cls)}>
        {c.icon} {c.label}
      </span>
    </DataTip>
  );
}

/* ---------- pricing helpers ---------- */
function ncdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t
    * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + (x >= 0 ? y : -y));
}
function bsPrice(side: "put" | "call", S: number, K: number, iv: number, tYears: number): number {
  if (tYears <= 0 || iv <= 0) return side === "call" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  const sd = iv * Math.sqrt(tYears);
  const d1 = (Math.log(S / K) + 0.5 * sd * sd) / sd;
  const d2 = d1 - sd;
  return side === "call" ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
}

type Tpl = NonNullable<S["template"]>;
function payoff(t: Tpl): { x: number; y: number; pos: number; neg: number }[] {
  const N = 200, lo = t.spot * 0.7, hi = t.spot * 1.3;
  const out: { x: number; y: number; pos: number; neg: number }[] = [];
  for (let i = 0; i < N; i++) {
    const x = lo + ((hi - lo) * i) / (N - 1);
    let v = t.credit;
    for (const l of t.legs) {
      const rem = l.dte - t.dte;
      const val = rem > 0
        ? bsPrice(l.side, x, l.strike, t.iv, rem / 365)
        : l.side === "call" ? Math.max(x - l.strike, 0) : Math.max(l.strike - x, 0);
      v += l.qty * val;
    }
    if (t.stock) v += x - t.spot;
    const y = 100 * v;
    out.push({ x: +x.toFixed(2), y: +y.toFixed(2), pos: Math.max(y, 0), neg: Math.min(y, 0) });
  }
  return out;
}

/* ---------- small pieces ---------- */
function Card({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return (
    <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-2 min-w-0">
      <div className="text-[11px] font-semibold text-[#d4af37] mb-1">{title}</div>
      <div className="h-[180px]">{children}</div>
      {caption ? <div className="text-[10px] text-amber-100/50 mt-1">{caption}</div> : null}
    </div>
  );
}
const NoData = () => <div className="h-full flex items-center justify-center text-[11px] text-amber-100/50">No data</div>;

function Tile({ label, tip, children }: { label: string; tip?: string; children: ReactNode }) {
  return (
    <div className="rounded border border-[#d4af37]/20 bg-black/40 px-2 py-1 min-w-[84px]">
      <div className="text-[9px] uppercase tracking-wide text-amber-100/50">
        <DataTip tip={tip}>{label}</DataTip>
      </div>
      <div className="font-mono tabular-nums text-sm font-semibold text-white">{children}</div>
    </div>
  );
}

/** Diverging bar on a shared scale; value fraction, `scale` = max |value| shown. */
function DivBar({ v, scale }: { v: number | null | undefined; scale: number }) {
  const ok = fin(v);
  const raw = ok ? Math.abs(v) / (scale || 1) : 0;
  const clipped = raw > 1;
  const w = Math.min(raw, 1) * 50;
  const gain = ok && v >= 0;
  return (
    <div className="relative h-3 flex-1 min-w-0">
      <div className="absolute inset-y-0 left-1/2 w-px bg-[#71717a]" />
      {ok ? (
        <div
          className="absolute inset-y-0.5 rounded-sm"
          style={{ background: gain ? GAIN : LOSS, width: `${w}%`, left: gain ? "50%" : `${50 - w}%` }}
        />
      ) : null}
      {clipped ? (
        <span className="absolute -top-0.5 text-[10px] leading-3 text-amber-100" style={gain ? { right: 0 } : { left: 0 }}>
          {gain ? "›" : "‹"}
        </span>
      ) : null}
    </div>
  );
}

/* ---------- charts ---------- */
function PayoffChart({ t }: { t: Tpl | null }) {
  const data = useMemo(() => (t ? payoff(t) : []), [t]);
  if (!t || !data.length) return <NoData />;
  const be: { x: number }[] = [];
  for (let i = 1; i < data.length; i++) {
    const a = data[i - 1], b = data[i];
    if ((a.y < 0 && b.y > 0) || (a.y > 0 && b.y < 0)) be.push({ x: +(a.x + ((b.x - a.x) * -a.y) / (b.y - a.y)).toFixed(1) });
  }
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 14, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="x" type="number" domain={["dataMin", "dataMax"]} tick={AXIS_TICK} tickFormatter={(v) => `$${Math.round(v)}`} stroke={AXIS} />
        <YAxis tick={AXIS_TICK} tickFormatter={(v) => `$${Math.round(v)}`} stroke={AXIS} width={48} />
        <Area dataKey="pos" stroke="none" fill={GAIN} fillOpacity={0.15} baseValue={0} isAnimationActive={false} />
        <Area dataKey="neg" stroke="none" fill={LOSS} fillOpacity={0.15} baseValue={0} isAnimationActive={false} />
        <ReferenceLine y={0} stroke={AXIS} />
        <ReferenceLine x={t.spot} stroke={AXIS} strokeDasharray="4 3" />
        <Line dataKey="y" stroke={GOLD} strokeWidth={2} dot={false} isAnimationActive={false} />
        {be.map((b) => (
          <ReferenceDot
            key={b.x} x={b.x} y={0} r={3} fill={GOLD} stroke="#09090b"
            label={{ value: `$${b.x}`, position: "top", fill: TXT, fontSize: 10 }}
          />
        ))}
        <RTooltip
          contentStyle={TIP_STYLE} labelStyle={{ color: "#fef3c7" }}
          labelFormatter={(v) => `Price $${Number(v).toFixed(1)}`}
          formatter={(_v, name, p) => (name === "y" ? [`${p.payload.y >= 0 ? "+" : "−"}$${Math.abs(p.payload.y).toFixed(0)}`, "P/L"] : [null, null]) as [string, string]}
          filterNull
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function EquityChart({ s }: { s: S }) {
  const data = (s.equity ?? []).filter((e) => fin(e.cum));
  if (!data.length) return <NoData />;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="m" tick={AXIS_TICK} stroke={AXIS} minTickGap={28} />
        <YAxis tick={AXIS_TICK} stroke={AXIS} width={44} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
        <ReferenceLine y={0} stroke={AXIS} />
        <Area dataKey="cum" stroke="none" fill={GOLD} fillOpacity={0.1} baseValue={0} isAnimationActive={false} />
        <Line dataKey="cum" stroke={GOLD} strokeWidth={2} dot={false} isAnimationActive={false} />
        <RTooltip
          contentStyle={TIP_STYLE} cursor={{ stroke: AXIS }}
          content={({ active, payload }) => {
            const p = active ? payload?.[0]?.payload as S["equity"][number] | undefined : undefined;
            if (!p) return null;
            return (
              <div style={TIP_STYLE} className="px-2 py-1 font-mono tabular-nums">
                <div>{p.m}</div>
                <div>{spct(p.ret)} avg/trade</div>
                <div>cum {spct(p.cum)}</div>
                <div>{p.n} trades</div>
              </div>
            );
          }}
        />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

function HistChart({ s }: { s: S }) {
  const h = s.hist;
  const total = h?.counts?.reduce((a, b) => a + b, 0) ?? 0;
  if (!h || !h.counts?.length || !total) return <NoData />;
  const data = h.counts.map((c, i) => {
    const lo = h.lo + i * h.w, hi = lo + h.w;
    return { label: `${(((lo + hi) / 2) * 100).toFixed(0)}%`, lo, hi, c, share: (c / total) * 100, neg: hi <= 0 };
  });
  const zero = data.find((d) => d.lo <= 0 && d.hi > 0);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 0 }} barCategoryGap={0}>
        <CartesianGrid vertical={false} stroke={GRID} />
        <XAxis dataKey="label" tick={AXIS_TICK} stroke={AXIS} interval={3} />
        <YAxis tick={AXIS_TICK} stroke={AXIS} width={36} tickFormatter={(v) => `${Math.round(v)}%`} />
        {zero ? <ReferenceLine x={zero.label} stroke={AXIS} /> : null}
        <Bar dataKey="share" radius={[4, 4, 0, 0]} stroke="#09090b" strokeWidth={1} isAnimationActive={false}>
          {data.map((d, i) => <Cell key={i} fill={d.neg ? LOSS : GAIN} />)}
        </Bar>
        <RTooltip
          contentStyle={TIP_STYLE} cursor={{ fill: "rgba(212,175,55,0.08)" }}
          content={({ active, payload }) => {
            const p = active ? payload?.[0]?.payload as (typeof data)[number] | undefined : undefined;
            if (!p) return null;
            return (
              <div style={TIP_STYLE} className="px-2 py-1 font-mono tabular-nums">
                {spct(p.lo, 0)} to {spct(p.hi, 0)} · {p.share.toFixed(0)} % of trades ({p.c})
              </div>
            );
          }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

function WhenWorks({ s }: { s: S }) {
  const rows: { k: string; n: number; mean: number; win: number | null; worst5: number | null }[] = [];
  // by name, in time order: Postgres jsonb reorders object keys (shorter first), so Object.entries order is not 2021 → 2024
  for (const k of ERA_KEYS) { const e = s.eras?.[k]; if (e && e.n >= 30) rows.push({ k, n: e.n, mean: e.mean, win: e.win, worst5: e.worst5 }); }
  for (const [k, r] of Object.entries(s.regimes ?? {})) if (r && r.n >= 30) rows.push({ k, n: r.n, mean: r.mean, win: r.win, worst5: r.worst5 });
  if (!rows.length) return <NoData />;
  const scale = Math.max(...rows.map((r) => Math.abs(r.mean)), 0.001);
  return (
    <div className="h-full overflow-y-auto space-y-1 pr-1">
      {rows.map((r) => (
        <DataTip key={r.k} className="w-full" tip={`n ${r.n} · win ${upct(r.win)} · worst 5 % ${spct(r.worst5)}`}>
          <div className="flex items-center gap-2 w-full text-[10px]">
            <span className="w-[42%] truncate text-amber-100">{r.k}</span>
            <DivBar v={r.mean} scale={scale} />
            <span className={cn("w-14 text-right font-mono tabular-nums", tone(r.mean))}>{spct(r.mean)}</span>
          </div>
        </DataTip>
      ))}
    </div>
  );
}

/* ---------- main ---------- */
export function StructureLab() {
  const { data, isLoading } = useQuery({
    queryKey: ["structures-backtest"],
    queryFn: async (): Promise<Resp> => {
      const r = await fetch("/api/options/structures/backtest", { credentials: "include" });
      if (!r.ok) throw new Error("backtest fetch failed");
      return r.json();
    },
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });
  const [sel, setSel] = useState<string | null>(null);
  const [table, setTable] = useState(false);

  const sorted = useMemo(() => {
    const list = [...(data?.structures ?? [])];
    // rank by return ÷ risk: return-on-capital alone flatters margin structures (strangle capital = 20 % of the stock)
    const key = (s: S) => primary(s)?.sharpe ?? primary(s)?.mean;
    return list.sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (!fin(ka) && !fin(kb)) return 0;
      if (!fin(ka)) return 1;
      if (!fin(kb)) return -1;
      return kb - ka;
    });
  }, [data]);

  const scale = useMemo(() => {
    const abs = sorted.map((s) => barValue(s)).filter(fin).map(Math.abs).sort((a, b) => a - b);
    if (!abs.length) return 0.01;
    return Math.max(abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))], 0.001);
  }, [sorted]);

  if (isLoading) return <p className="text-xs text-amber-100 mt-3">Loading…</p>;
  if (!data?.structures?.length) return <p className="text-xs text-amber-100/50 mt-3">Backtest not run yet (S076).</p>;

  const cur = sorted.find((s) => s.id === sel) ?? sorted[0];
  const sum = primary(cur);
  const allEntries = !cur.as_shown && !!cur.all;

  return (
    <div className="mt-4 space-y-2 text-xs">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-0.5">
        <span className="text-[#d4af37] font-bold text-sm">
          <DataTip tip={data.structures[0]?.method || null}>Backtest lab</DataTip>
        </span>
        <span className="text-amber-100/50">
          {data.structures.length} structures · 2021 → · as of {formatMdYy(data.asOf)}
        </span>
      </div>

      {/* Overview */}
      <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-2">
        <div className="flex items-baseline justify-between mb-1 gap-2">
          <span className="text-[10px] text-amber-100/50">
            <DataTip tip="Average trade result ÷ how much results swing (standard deviation). Same yardstick for every structure: return on capital alone flatters margin trades (a strangle's capital is 20 % of the stock). Cash-secured put is the benchmark.">
              Ranked by return ÷ risk (higher = steadier money)
            </DataTip>
          </span>
          <button
            type="button" onClick={() => setTable((t) => !t)}
            className="text-[10px] text-amber-100/50 hover:text-[#d4af37] underline decoration-dotted"
          >
            {table ? "bars" : "table"}
          </button>
        </div>
        {table ? (
          <div className={GRID_WRAP}>
            <table className="w-full border-collapse">
              <thead>
                <tr className={GRID_HEADER}>
                  {["Name", "Verdict", "n", "Mean", "Win", "Median", "Worst 5 %", "t", "2021–23", "2024 →"].map((h, i) => (
                    <th key={h} className={cn(GRID_TH, i < 2 ? "text-left" : "text-right")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((s, i) => {
                  const p = primary(s);
                  const eras = ERA_KEYS.map((k) => s.eras?.[k]);
                  return (
                    <tr key={s.id} className={cn(gridRow(i), "cursor-pointer")} onClick={() => setSel(s.id)}>
                      <td className={cn(GRID_TD, "text-white", s.id === cur.id && "border-l-2 border-[#d4af37]")}>{s.name}</td>
                      <td className={GRID_TD}><Chip s={s} /></td>
                      <td className={cn(GRID_TD, "text-right font-mono text-amber-50")}>{p?.n ?? "—"}</td>
                      <td className={cn(GRID_TD, "text-right font-mono font-semibold", tone(p?.mean))}>{spct(p?.mean)}</td>
                      <td className={cn(GRID_TD, "text-right font-mono text-white")}>{upct(p?.win)}</td>
                      <td className={cn(GRID_TD, "text-right font-mono", tone(p?.median))}>{spct(p?.median)}</td>
                      <td className={cn(GRID_TD, "text-right font-mono text-red-300")}>{spct(p?.worst5)}</td>
                      <td className={cn(GRID_TD, "text-right font-mono text-amber-50")}>{fin(p?.t) ? p.t.toFixed(1) : "—"}</td>
                      <td className={cn(GRID_TD, "text-right font-mono", tone(eras[0]?.mean))}>{spct(eras[0]?.mean)}</td>
                      <td className={cn(GRID_TD, "text-right font-mono", tone(eras[1]?.mean))}>{spct(eras[1]?.mean)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="space-y-0.5">
            {sorted.map((s) => {
              const p = primary(s);
              return (
                <button
                  key={s.id} type="button" onClick={() => setSel(s.id)}
                  className={cn(
                    "w-full flex items-center gap-2 px-1.5 py-0.5 text-left border-l-2",
                    s.id === cur.id ? "border-[#d4af37] bg-[#d4af37]/5" : "border-transparent hover:bg-white/5",
                  )}
                >
                  <span className="w-[30%] sm:w-[22%] truncate font-semibold text-white">{s.name}</span>
                  <span className="hidden sm:inline-block w-[92px] shrink-0"><Chip s={s} /></span>
                  <DivBar v={barValue(s)} scale={scale} />
                  <span className={cn("w-14 text-right font-mono tabular-nums font-semibold", tone(barValue(s)))}>{fin(barValue(s)) ? (barValue(s) as number).toFixed(2) : "—"}</span>
                  <span className="hidden md:inline w-16 text-right font-mono text-[10px] text-amber-100/50">win {upct(p?.win)}</span>
                  <span className="hidden md:inline w-24 text-right font-mono text-[10px] text-amber-100/50">worst 5 % {spct(p?.worst5, 0)}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Detail */}
      <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-2 space-y-2">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-white font-semibold text-sm">{cur.name}</span>
          <Chip s={cur} />
          <span className="text-amber-100/50 truncate max-w-full">{cur.description}</span>
        </div>
        {cur.why ? <p className="text-[11px] text-amber-100/70 leading-snug">{cur.why}</p> : null}
        {sum ? (
          <>
            <div className="flex flex-wrap gap-1.5 items-stretch">
              <Tile label="Avg / trade" tip="Average past trade result as % of the capital it tied up, after realistic fills and minus what the cash would have earned in T-bills. Covered call / collar: compared with just holding the shares.">
                <span className={tone(sum.mean)}>{spct(sum.mean)}</span>
              </Tile>
              <Tile label="Per $100 stock" tip="Average result per trade per $100 of the stock's price — comparable across structures.">
                <span className={tone(sum.per_stock)}>{per100(sum.per_stock)}</span>
              </Tile>
              <Tile label="Return ÷ risk" tip="Mean ÷ standard deviation of trade results. Higher = steadier. CSP is the benchmark.">
                {fin(sum.sharpe) ? sum.sharpe.toFixed(2) : "—"}
              </Tile>
              <Tile label="Win rate" tip="Share of past trades that made money (any amount).">{upct(sum.win)}</Tile>
              <Tile label="Median" tip="The middle trade: half did better, half worse. Far below the average = a few big wins carry it."><span className={tone(sum.median)}>{spct(sum.median)}</span></Tile>
              <Tile label="Worst 5 %" tip="The bad-case trade: 1 in 20 past trades lost this much of the capital or more."><span className="text-red-300">{spct(sum.worst5)}</span></Tile>
              <Tile label="Trades" tip="Past trades in the backtest (2021 →, every Monday, ~260 names), only those the board would have shown.">{sum.n}</Tile>
              <Tile label="Confidence" tip="t-stat of the mean. 2 or more ≈ unlikely to be luck.">t {fin(sum.t) ? sum.t.toFixed(1) : "—"}</Tile>
              <Tile label="Avg hold" tip="Days from entry to expiry (held to expiry, no early exit).">{fin(sum.days) ? `${Math.round(sum.days)}d` : "—"}</Tile>
              {allEntries ? <span className="self-end text-[10px] text-amber-100/50">(all entries)</span> : null}
            </div>
            {sum.scen ? (
              <div className="text-[10px] text-amber-100/50">
                <DataTip tip="Same trades re-priced with far-OTM option prices ±10 %; a verdict that flips is pricing-sensitive.">
                  Pricing check
                </DataTip>
                : cheap {spct(sum.scen.cheap)} · base {spct(sum.scen.base)} · rich {spct(sum.scen.rich)}
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-[11px] text-amber-100/50">No trades in the backtest for this structure.</p>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <Card
          title="Payoff at expiry"
          caption={cur.template ? `Example: $100 stock, IV 50 %, ${cur.template.dte} days — the shape, not today's pick.` : undefined}
        >
          <PayoffChart t={cur.template} />
        </Card>
        <Card title="Cumulative excess return" caption="Sum of monthly average trade results (equal weight).">
          <EquityChart s={cur} />
        </Card>
        <Card title="Outcome distribution">
          <HistChart s={cur} />
        </Card>
        <Card title="When it works" caption="n < 30 → hidden">
          <WhenWorks s={cur} />
        </Card>
      </div>

      <p className="text-[10px] text-amber-100/50 px-0.5">
        Backtest S076 · held to expiry · fills bid + 23 % of spread · earnings weeks excluded · not advice
      </p>
    </div>
  );
}
