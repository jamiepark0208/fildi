/**
 * Rankings › Structures › Backtest lab (S076). Per-structure results from the 2021→ backtest.
 */
import { Fragment, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { STRUCTURES_META_SLOT_ID } from "./structure-slots";
import {
  Area, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, ReferenceDot, ReferenceLine,
  ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis,
} from "recharts";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
import { formatMdYy } from "@/lib/format";
import { THEME_META, THEME_ORDER, themeOf, simpleOf, type TradeTheme } from "./structure-themes";
import { StructurePicksTable, useStructuresBoard, type StructurePick } from "./structure-picks";
import { LongOptionBoard } from "./LongOptionBoard";
import { StructureBuilder } from "./StructureBuilder";
import { StructureRanker } from "./StructureRanker";
import { StrategyGuide } from "./StrategyGuide";
import { blendScores, deskAction } from "./structure-desk";

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

/** Solid chips — Promising = yellow (Jamie 10-24). */
const CHIP: Record<Verdict, { icon: string; label: string; cls: string }> = {
  works: { icon: "✓", label: "Works", cls: "bg-emerald-700 text-white border-emerald-500" },
  promising: { icon: "◐", label: "Promising", cls: "bg-yellow-400 text-black border-yellow-300" },
  fails: { icon: "✕", label: "Fails", cls: "bg-red-800 text-white border-red-500" },
  untested: { icon: "·", label: "Untested", cls: "bg-zinc-700 text-white border-zinc-500" },
};

/** Verdicts are BACKWARD-LOOKING S076 history only — not a forward forecast. */
const VERDICT_TIP: Record<Verdict, string> = {
  works: "BACKWARD-LOOKING (S076, 2021→ after fills). Structure made money historically. Not a forecast.",
  promising: "BACKWARD-LOOKING. Positive in the backtest but not proven (small sample / luck). Not a forecast.",
  fails: "BACKWARD-LOOKING. Lost money after fills (or lost vs cash-secured put). Example: long put FAIL = buying puts lost in a mostly rising 2021→ tape — not a claim puts can't work in a crash. Not forward-looking.",
  untested: "BACKWARD-LOOKING. Not enough clean history to grade yet.",
};

const fin = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
const spct = (v: number | null | undefined, d = 1) =>
  !fin(v) ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(d)} %`;
const upct = (v: number | null | undefined, d = 0) => (!fin(v) ? "—" : `${(v * 100).toFixed(d)} %`);
const tone = (v: number | null | undefined) => (!fin(v) || v === 0 ? "text-white" : v > 0 ? "text-emerald-300" : "text-red-300");
/** Win %: green ≥65, yellow ≥45, else red. */
const winTone = (v: number | null | undefined) =>
  !fin(v) ? "text-amber-100" : v >= 0.65 ? "text-emerald-300" : v >= 0.45 ? "text-yellow-300" : "text-red-300";
/** Ret÷risk: green ≥0.10, yellow ≥0, else red. */
const sharpeTone = (v: number | null | undefined) =>
  !fin(v) ? "text-amber-100" : v >= 0.10 ? "text-emerald-300" : v >= 0 ? "text-yellow-300" : "text-red-300";
/** Worst 5 % (negative): green > −10 %, yellow > −35 %, else red. −100 % = wiped the capital in that bad case. */
const worstTone = (v: number | null | undefined) =>
  !fin(v) ? "text-amber-100" : v > -0.10 ? "text-emerald-300" : v > -0.35 ? "text-yellow-300" : "text-red-300";
const primary = (s: S): Sum => s.as_shown ?? s.all;
const barValue = (s: S): number | undefined => primary(s)?.sharpe ?? primary(s)?.mean;

function Chip({ s }: { s: S }) {
  const c = CHIP[s.verdict] ?? CHIP.untested;
  const tip = [VERDICT_TIP[s.verdict] ?? VERDICT_TIP.untested, s.why].filter(Boolean).join("\n\n");
  return (
    <DataTip tip={tip}>
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
function ChartPane({ title, tip, children }: { title: string; tip?: string; children: ReactNode }) {
  return (
    <div className="rounded border border-[#d4af37]/25 bg-zinc-950 p-2 min-w-0">
      <div className="text-[10px] font-semibold text-white mb-1 tracking-wide">
        <DataTip tip={tip}>{title}</DataTip>
      </div>
      <div className="h-[160px]">{children}</div>
    </div>
  );
}
const NoData = () => <div className="h-full flex items-center justify-center text-[11px] text-amber-100">No data</div>;

type MetricCell = { label: string; tip?: string; value: ReactNode; cls?: string };

/** One-row dense metrics (ag-grid look). */
function CompactMetrics({ cells }: { cells: MetricCell[] }) {
  return (
    <div className={cn(GRID_WRAP, "w-full min-w-0")}>
      <table className="w-full border-collapse">
        <thead>
          <tr className={GRID_HEADER}>
            {cells.map((c) => (
              <th key={c.label} className={cn(GRID_TH, "!py-0.5 !px-1.5 !text-[9px] text-right")}>
                <DataTip tip={c.tip}>{c.label}</DataTip>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className={gridRow(0)}>
            {cells.map((c) => (
              <td key={c.label} className={cn(GRID_TD, "!py-0.5 !px-1.5 text-right font-mono text-[11px] font-semibold tabular-nums", c.cls ?? "text-white")}>
                {c.value}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

const STOCK_STRUCT = new Set(["covered_call", "collar"]);

/** Live pick → payoff template (same math as S076 example shape). */
function pickToTpl(r: StructurePick, structureId: string): Tpl {
  const ivs = r.legs.map((l) => l.iv).filter((v) => v > 0);
  const iv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0.3;
  return {
    spot: r.spot,
    iv,
    dte: r.dte,
    credit: r.credit,
    capital: r.capital,
    stock: STOCK_STRUCT.has(structureId),
    legs: r.legs.map((l) => ({ side: l.side, strike: l.strike, qty: l.qty, px: l.px, dte: r.dte })),
  };
}

function ExpandDetail({
  s, picks, asOf, sAll,
}: {
  s: S; picks: StructurePick[]; asOf: string | null; sAll: boolean;
}) {
  const tickersKey = picks.map((p) => p.ticker).join("|");
  const [pickT, setPickT] = useState<string | null>(() => picks[0]?.ticker ?? null);
  useEffect(() => {
    if (!picks.length) { setPickT(null); return; }
    setPickT((prev) => (prev && picks.some((p) => p.ticker === prev) ? prev : picks[0]!.ticker));
  }, [s.id, tickersKey]); // eslint-disable-line react-hooks/exhaustive-deps -- tickersKey tracks pick set

  const pick = useMemo(() => picks.find((p) => p.ticker === pickT) ?? null, [picks, pickT]);
  const sSum = primary(s);
  const tpl = useMemo(() => {
    if (pick) return pickToTpl(pick, s.id);
    return s.template;
  }, [pick, s.id, s.template]);

  const usdC = (v: number | null | undefined) =>
    v == null || !Number.isFinite(v) ? "—" : `$${Math.abs(v * 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

  const cells: MetricCell[] = pick
    ? [
        { label: "Pick", tip: "Selected morning pick — click another row below.", value: pick.ticker, cls: "text-[#d4af37]" },
        { label: "Credit", tip: "Premium per contract (×100).", value: `${pick.credit >= 0 ? "+" : "−"}${usdC(pick.credit)}`, cls: pick.credit >= 0 ? "text-emerald-300" : "text-red-300" },
        { label: "Capital", tip: "Cash / margin / max loss per contract.", value: usdC(pick.capital), cls: "text-amber-50" },
        { label: "Win", tip: "Market-IV odds of profit at expiry.", value: upct(pick.p_mkt), cls: winTone(pick.p_mkt) },
        { label: "Expected", tip: "2y history avg ÷ capital.", value: spct(pick.ev_rv_cap), cls: tone(pick.ev_rv_cap) },
        { label: "Bad case", tip: "1-in-20 ÷ capital.", value: spct(pick.worst5, 0), cls: worstTone(pick.worst5) },
        { label: "IV/RV", tip: "Implied ÷ 20d realized.", value: fin(pick.iv_rv) ? pick.iv_rv.toFixed(2) : "—", cls: "text-white" },
        { label: "DTE", tip: "Days to expiry.", value: `${pick.dte}d`, cls: "text-amber-100" },
      ]
    : sSum
      ? [
          { label: "Avg", tip: "Avg past trade ÷ capital after fills.", value: spct(sSum.mean), cls: tone(sSum.mean) },
          { label: "/$100", tip: "Avg result per $100 of stock.", value: per100(sSum.per_stock), cls: tone(sSum.per_stock) },
          { label: "Ret÷risk", tip: "Mean ÷ sd.", value: fin(sSum.sharpe) ? sSum.sharpe!.toFixed(2) : "—", cls: sharpeTone(sSum.sharpe) },
          { label: "Win", tip: "Share of past trades that made money.", value: upct(sSum.win), cls: winTone(sSum.win) },
          { label: "Median", value: spct(sSum.median), cls: tone(sSum.median) },
          { label: "Worst5%", value: spct(sSum.worst5), cls: worstTone(sSum.worst5) },
          { label: "Trades", value: sSum.n, cls: "text-white" },
          { label: "t", tip: "Confidence (t-stat).", value: fin(sSum.t) ? sSum.t.toFixed(1) : "—", cls: "text-white" },
          { label: "Hold", value: fin(sSum.days) ? `${Math.round(sSum.days)}d` : "—", cls: "text-amber-100" },
          ...(sAll ? [{ label: "Note", value: "all", tip: "All entries (not as-shown filter).", cls: "text-amber-100" } as MetricCell] : []),
        ]
      : [];

  return (
    <div className="space-y-2 w-full min-w-0">
      {cells.length ? <CompactMetrics cells={cells} /> : null}
      <StructurePicksTable
        structureId={s.id}
        rows={picks}
        asOf={asOf}
        selected={pickT}
        onSelect={setPickT}
      />
      {s.id === "long_call" ? <LongOptionBoard side="call" /> : null}
      {s.id === "long_put" ? <LongOptionBoard side="put" /> : null}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 w-full min-w-0">
        <ChartPane
          title={pick ? `Payoff · ${pick.ticker}` : "Payoff at expiry"}
          tip={pick ? `${pick.ticker} legs at morning fill · spot $${pick.spot.toFixed(2)}.` : "Example shape from backtest template."}
        >
          <PayoffChart t={tpl} />
        </ChartPane>
        <ChartPane
          title="Cumulative excess"
          tip="S076 structure history (all names) — same curve for every pick of this structure. Pick selection changes payoff + metrics above."
        >
          <EquityChart s={s} />
        </ChartPane>
        <ChartPane title="Outcome mix" tip="Distribution of past trade returns for this structure.">
          <HistChart s={s} />
        </ChartPane>
        <ChartPane title="By regime" tip="Mean return when n ≥ 30 in each era / regime bucket.">
          <WhenWorks s={s} />
        </ChartPane>
      </div>
    </div>
  );
}

/** Narrow diverging bar; `scale` = max |value| shown. */
function DivBar({ v, scale }: { v: number | null | undefined; scale: number }) {
  const ok = fin(v);
  const raw = ok ? Math.abs(v) / (scale || 1) : 0;
  const clipped = raw > 1;
  const w = Math.min(raw, 1) * 50;
  const gain = ok && v >= 0;
  return (
    <div className="relative h-2.5 w-16 shrink-0">
      <div className="absolute inset-y-0 left-1/2 w-px bg-[#71717a]" />
      {ok ? (
        <div
          className="absolute inset-y-0.5 rounded-sm"
          style={{ background: gain ? GAIN : LOSS, width: `${w}%`, left: gain ? "50%" : `${50 - w}%` }}
        />
      ) : null}
      {clipped ? (
        <span className="absolute -top-0.5 text-[9px] leading-3 text-amber-100" style={gain ? { right: 0 } : { left: 0 }}>
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
type LabTab = "backtest" | "guide" | "builder" | "ranker";

type BuilderLeg = {
  kind: "stock" | "call" | "put";
  side: "long" | "short";
  qty: number;
  strike?: number;
  expiry?: string;
};

export function StructureLab() {
  const [labTab, setLabTab] = useState<LabTab>("backtest");
  const [builderSeed, setBuilderSeed] = useState<{ ticker: string; legs: BuilderLeg[] } | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["structures-backtest"],
    queryFn: async (): Promise<Resp> => {
      const r = await fetch("/api/options/structures/backtest", { credentials: "include" });
      if (!r.ok) throw new Error("backtest fetch failed");
      return r.json();
    },
    staleTime: 30 * 60_000,
    refetchInterval: 60 * 60_000,
    refetchOnWindowFocus: true,
  });
  const board = useStructuresBoard();
  const [sel, setSel] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<TradeTheme>>(() => new Set());
  const [metaSlot, setMetaSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setMetaSlot(document.getElementById(STRUCTURES_META_SLOT_ID));
  }, []);

  const blendById = useMemo(() => {
    const list = data?.structures ?? [];
    const scores = blendScores(list.map((s) => {
      const p = primary(s);
      return { sharpe: p?.sharpe, win: p?.win, mean: p?.mean, worst5: p?.worst5 };
    }));
    const m = new Map<string, number>();
    list.forEach((s, i) => m.set(s.id, scores[i] ?? 0));
    return m;
  }, [data]);

  const byTheme = useMemo(() => {
    const list = [...(data?.structures ?? [])].sort(
      (a, b) => (blendById.get(b.id) ?? 0) - (blendById.get(a.id) ?? 0),
    );
    const map = new Map<TradeTheme, S[]>();
    for (const t of THEME_ORDER) map.set(t, []);
    for (const s of list) {
      const th = themeOf(s.id);
      (map.get(th) ?? map.get("hedge")!).push(s);
    }
    return THEME_ORDER.map((t) => ({ theme: t, rows: map.get(t) ?? [] })).filter((g) => g.rows.length);
  }, [data, blendById]);

  const flat = useMemo(() => byTheme.flatMap((g) => g.rows), [byTheme]);

  const scale = useMemo(() => {
    const abs = flat.map((s) => barValue(s)).filter(fin).map(Math.abs).sort((a, b) => a - b);
    if (!abs.length) return 0.01;
    return Math.max(abs[Math.min(abs.length - 1, Math.floor(abs.length * 0.95))], 0.001);
  }, [flat]);

  const pickCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of board.data?.structures ?? []) m.set(s.id, s.rows.length);
    return m;
  }, [board.data]);

  const tabBar = (
    <div className="flex gap-1 border-b border-zinc-800 pb-1 mb-1">
      {(["backtest", "guide", "builder", "ranker"] as const).map((t) => (
        <button
          key={t}
          type="button"
          className={cn(
            "px-2 py-0.5 rounded-t text-[10px] uppercase font-semibold",
            labTab === t ? "bg-[#d4af37]/25 text-[#fef3c7] border border-[#d4af37]/40" : "text-amber-100",
          )}
          onClick={() => setLabTab(t)}
        >
          {t === "backtest" ? "Backtest" : t === "guide" ? "Guide" : t === "builder" ? "Builder" : "Ranker"}
        </button>
      ))}
    </div>
  );

  if (labTab === "guide") {
    return (
      <div className="space-y-1.5 text-xs">
        {tabBar}
        <StrategyGuide
          onBuild={(ticker, legs) => {
            setBuilderSeed({ ticker, legs });
            setLabTab("builder");
          }}
        />
      </div>
    );
  }
  if (labTab === "builder") {
    return (
      <div className="space-y-1.5 text-xs">
        {tabBar}
        <StructureBuilder seedTicker={builderSeed?.ticker} seedLegs={builderSeed?.legs ?? undefined} />
      </div>
    );
  }
  if (labTab === "ranker") {
    return (
      <div className="space-y-1.5 text-xs">
        {tabBar}
        <StructureRanker />
      </div>
    );
  }

  if (isLoading) return <p className="text-xs text-amber-100 mt-1">Loading…</p>;
  if (!data?.structures?.length) return <p className="text-xs text-amber-100 mt-1">Backtest not run yet (S076).</p>;

  const totalPicks = [...pickCount.values()].reduce((a, b) => a + b, 0);
  const toggle = (id: string) => setSel((prev) => (prev === id ? null : id));
  const toggleTheme = (t: TradeTheme) => setCollapsed((prev) => {
    const n = new Set(prev);
    if (n.has(t)) n.delete(t);
    else n.add(t);
    return n;
  });

  const boardAsOf = board.data?.asOf ?? data.asOf;
  const stanceAsOf = board.data?.stanceAsOf ?? boardAsOf;
  const desk = deskAction(board.data?.stance, stanceAsOf);
  // Stale if board date is before the last weekday (Fri when today is Sat/Sun/Mon-before-open).
  const stale = (() => {
    if (!boardAsOf) return true;
    const d = new Date(`${String(boardAsOf).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(d.getTime())) return true;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let lastWd = new Date(today);
    while (lastWd.getDay() === 0 || lastWd.getDay() === 6) lastWd.setDate(lastWd.getDate() - 1);
    // On weekend, last weekday is fine if board = that Friday; on a trading day, expect same calendar day.
    const expect = today.getDay() === 0 || today.getDay() === 6 ? lastWd : today;
    return d < new Date(expect.getFullYear(), expect.getMonth(), expect.getDate());
  })();

  const metaBar = (
    <>
      <span className="text-[#d4af37] font-bold tabular-nums">{formatMdYy(boardAsOf)}</span>
      {stale ? (
        <DataTip tip="Picks priced from the latest skew survey (daily.py → skew_survey.py → structures.py). Behind the last trading day means the survey job missed — re-run skew_survey + structures, or wait for Mon morning.">
          <span className="text-yellow-300 font-semibold">stale</span>
        </DataTip>
      ) : null}
      <span className="text-white font-semibold tabular-nums">{totalPicks} picks</span>
      <span className="text-amber-100 tabular-nums">{data.structures.length} structures</span>
      <DataTip tip={`${desk.tip} Desk as-of ${formatMdYy(stanceAsOf)}.`}>
        <span className="text-white cursor-help max-w-[min(520px,42vw)] truncate">
          <span className="text-[#d4af37] font-semibold mr-1">Do:</span>
          {desk.line}
        </span>
      </DataTip>
    </>
  );

  return (
    <div className="space-y-1.5 text-xs">
      {tabBar}
      {metaSlot ? createPortal(metaBar, metaSlot) : (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-0.5">{metaBar}</div>
      )}

      <div className={cn(GRID_WRAP, "w-full min-w-0")}>
          <table className="w-full min-w-0 border-collapse">
            <thead>
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "text-left w-4")} aria-label="expand" />
                <th className={cn(GRID_TH, "text-left")}>
                  <DataTip tip="Option structure by trade theme. Hover a name for a plain-English shape.">
                    Structure
                  </DataTip>
                </th>
                <th className={cn(GRID_TH, "text-left")}>
                  <DataTip tip="S076 historical verdict only (2021→ after fills). NOT a forward forecast.">
                    Verdict
                  </DataTip>
                </th>
                <th className={cn(GRID_TH, "text-right")}>
                  <DataTip tip="Sort key: blend of four backtest ratios (within this table) — ret÷risk 40%, win rate 25%, avg return 20%, milder bad-tail 15%. Higher = better overall historically. Not a forecast.">
                    Score
                  </DataTip>
                </th>
                <th className={cn(GRID_TH, "text-right")}>
                  <DataTip tip="One ratio: mean ÷ sd of past trades (steadiness). Used inside Score at 40%. Green ≥ 0.10.">
                    Ret ÷ risk
                  </DataTip>
                </th>
                <th className={cn(GRID_TH, "text-right hidden sm:table-cell")}>
                  <DataTip tip="% of past trades that made any money. Inside Score at 25%.">Win</DataTip>
                </th>
                <th className={cn(GRID_TH, "text-right hidden md:table-cell")}>
                  <DataTip tip="1-in-20 bad case ÷ capital. −100% = wiped capital in that case. Milder tails raise Score (15%).">
                    Worst 5 %
                  </DataTip>
                </th>
                <th className={cn(GRID_TH, "text-right hidden lg:table-cell")}>
                  <DataTip tip="Average past trade ÷ capital. Inside Score at 20%.">Avg</DataTip>
                </th>
                <th className={cn(GRID_TH, "text-right")}>
                  <DataTip tip="Today's morning picks for this structure (structures.py). Click a row in the expand to drive payoff + metrics.">
                    Today
                  </DataTip>
                </th>
              </tr>
            </thead>
            <tbody>
              {byTheme.map(({ theme, rows }) => {
                const meta = THEME_META[theme];
                const isCollapsed = collapsed.has(theme);
                return (
                  <Fragment key={theme}>
                    <tr
                      className={cn(meta.headerCls, "cursor-pointer")}
                      onClick={() => toggleTheme(theme)}
                    >
                      <td colSpan={9} className={cn(GRID_TD, "!py-0.5 leading-none")}>
                        <span className="inline-flex items-center gap-1">
                          {isCollapsed
                            ? <ChevronRight className="w-3 h-3 text-white" />
                            : <ChevronDown className="w-3 h-3 text-white" />}
                          <DataTip tip={meta.tip}>
                            <span className="text-white font-bold uppercase tracking-wide text-[10px]">
                              {meta.label}
                            </span>
                          </DataTip>
                          <span className="text-white/90 tabular-nums text-[10px] font-semibold">{rows.length}</span>
                        </span>
                      </td>
                    </tr>
                    {!isCollapsed && rows.map((s, i) => {
                      const p = primary(s);
                      const open = sel === s.id;
                      const nToday = pickCount.get(s.id) ?? 0;
                      const bv = barValue(s);
                      const blend = blendById.get(s.id) ?? 0;
                      const picks = board.data?.structures.find((b) => b.id === s.id)?.rows ?? [];
                      const sAll = !s.as_shown && !!s.all;
                      const simple = simpleOf(s.id, s.description);
                      return (
                        <Fragment key={s.id}>
                          <tr
                            className={cn(gridRow(i), "cursor-pointer", open && "bg-[#d4af37]/10")}
                            onClick={() => toggle(s.id)}
                          >
                            <td className={cn(GRID_TD, "w-4 text-[#d4af37]")}>
                              {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                            </td>
                            <td className={cn(GRID_TD, "text-white font-semibold")}>
                              <DataTip tip={simple}>{s.name}</DataTip>
                            </td>
                            <td className={GRID_TD}><Chip s={s} /></td>
                            <td className={cn(
                              GRID_TD, "text-right font-mono font-semibold",
                              blend >= 0.65 ? "text-emerald-300" : blend >= 0.4 ? "text-yellow-300" : "text-red-300",
                            )}>
                              <DataTip tip="Blend rank 0–1 across structures (ret÷risk 40 · win 25 · avg 20 · tail 15). Table sorted by this.">
                                {blend.toFixed(2)}
                              </DataTip>
                            </td>
                            <td className={cn(GRID_TD, "text-right")}>
                              <DataTip tip="Return ÷ risk (mean ÷ sd). One input to Score.">
                                <span className="inline-flex items-center justify-end gap-1.5">
                                  <DivBar v={bv} scale={scale} />
                                  <span className={cn("w-10 font-mono tabular-nums font-semibold", sharpeTone(bv))}>
                                    {fin(bv) ? bv.toFixed(2) : "—"}
                                  </span>
                                </span>
                              </DataTip>
                            </td>
                            <td className={cn(GRID_TD, "text-right font-mono hidden sm:table-cell", winTone(p?.win))}>
                              <DataTip tip="Share of past trades that made money (any amount).">{upct(p?.win)}</DataTip>
                            </td>
                            <td className={cn(GRID_TD, "text-right font-mono hidden md:table-cell", worstTone(p?.worst5))}>
                              <DataTip tip={
                                !fin(p?.worst5) ? null
                                  : p!.worst5 <= -0.99
                                    ? "−100 % = in the worst 5 % of past trades, the loss wiped ~all of the capital tied up (or more on undefined risk). Common on long options and naked short vol."
                                    : `1 in 20 past trades lost ${spct(p?.worst5, 0)} of capital or more.`
                              }>
                                {spct(p?.worst5, 0)}
                              </DataTip>
                            </td>
                            <td className={cn(GRID_TD, "text-right font-mono hidden lg:table-cell", tone(p?.mean))}>
                              <DataTip tip="Average past trade ÷ capital after fills.">{spct(p?.mean)}</DataTip>
                            </td>
                            <td className={cn(
                              GRID_TD, "text-right font-mono tabular-nums",
                              nToday ? "text-white font-bold" : "text-amber-100",
                            )}>
                              {nToday || "—"}
                            </td>
                          </tr>
                          {open ? (
                            <tr className="bg-zinc-950 border-y border-[#d4af37]/30">
                              <td
                                colSpan={9}
                                className="p-2 space-y-2 w-full min-w-0"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <ExpandDetail
                                  s={s}
                                  picks={picks}
                                  asOf={board.data?.asOf ?? null}
                                  sAll={sAll}
                                />
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
      </div>
    </div>
  );
}
