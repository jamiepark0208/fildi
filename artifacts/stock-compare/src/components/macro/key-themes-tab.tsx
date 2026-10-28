/**
 * Macro › Key Themes (Jamie 10-28): cyclical + secular themes with live signposts, scenarios, one unified read,
 * and money flows (market-cap flows by sector / players / theme baskets, AI money web, government cash flows).
 * Data: GET /api/macro/themes · GET /api/macro/money-flows (registry: research/market-views/themes.json, ai_deals.json).
 */
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { formatMdYy } from "@/lib/format";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
import type { MacroTab } from "@/components/macro/macro-page-types";

type Status = "bull" | "bear" | "neutral" | "stale" | "missing";
type Rule = [string, number];
interface Signpost {
  id: string; label: string; kind: string; unit?: string; tab?: string; note?: string;
  bull_if?: Rule; bear_if?: Rule; current: number | null; asOf: string | null; detail: string | null; status: Status;
}
interface Theme {
  id: string; name: string; horizon: "secular" | "cyclical" | "event"; weight: number; thesis: string;
  view: { stance: "bull" | "bear" | "neutral"; p: number; text: string; check: string };
  refs: string[]; signposts: Signpost[]; lean: string; score: number | null;
  bull: number; bear: number; neutral: number; missing: number; divergence: boolean; checkDue: boolean;
}
interface Scenario { id: string; name: string; path: string; spx_12m: string; p: number; signals: number; pointing: number }
interface ReadLayer { key: string; label: string; tier: "tested" | "untested" | "context"; readout: string; why: string; tab: string }
interface PlayRule { id: string; do: string; tier: "tested" | "hint" | "avoid"; evidence: string; active: boolean }
interface ThemesResp {
  updated: string; registryAgeDays: number; themes: Theme[]; scenarios: Scenario[]; scenarioSource: string;
  read: { marketState: string | null; sectorDrop: number; themeLean: number | null; layers: ReadLayer[]; pUp12m: number; playbook: PlayRule[]; note: string };
  asOf: Record<string, string | null>;
}
type Win = "1w" | "1m" | "3m";
interface Stats { cap: number; n: number; chg1w: number | null; chg1m: number | null; chg3m: number | null; pct1w: number | null; pct1m: number | null; pct3m: number | null }
interface Mover { ticker: string; chg: number; pct: number }
interface FlowsResp {
  window: Win;
  market: null | {
    asOf: string; dates: Record<Win, string>; total: Stats;
    sectors: (Stats & { sector: string; share: number; top: Mover[] })[];
    players: (Stats & { ticker: string; sector: string; group: string; share: number })[];
    baskets: (Stats & { basket: string; top: Mover[] })[];
  };
  web: null | {
    updated: string;
    nodes: { id: string; public: boolean; value_b: number | null; pct1m: number | null; as_of: string | null; note?: string }[];
    edges: { from: string; to: string; type: string; amount_b: number | null; date: string; note?: string }[];
  };
  gov: {
    monthly: { month: string; receipts: number; outlays: number; deficit: number }[];
    weekly: { week: string; spend: number; receipts: number; deficit: number; net_borrow: number; interest: number; defense: number; tga: number }[];
    deficit12m: number | null;
  };
}

const STATUS_CHIP: Record<Status | "bull" | "bear" | "neutral", string> = {
  bull: "bg-emerald-700 text-white", bear: "bg-red-700 text-white", neutral: "bg-zinc-700 text-white",
  stale: "bg-amber-800 text-white", missing: "bg-zinc-800 text-white",
};
const READ_CHIP: Record<string, string> = {
  Constructive: "bg-emerald-700 text-white", Mixed: "bg-zinc-700 text-white", Defensive: "bg-red-700 text-white",
};
const HORIZON_LABEL = { secular: "Secular", cyclical: "Cyclical", event: "Event" } as const;
const EDGE = {
  investment: { color: "#0284c7", dash: "", label: "Investment" },
  hardware: { color: "#ec4899", dash: "6 3", label: "Hardware" },
  compute: { color: "#65a30d", dash: "2 3", label: "Compute / cloud" },
  vc: { color: "#a855f7", dash: "10 4", label: "Venture" },
} as const;

const fmtB = (b: number | null | undefined) =>
  b == null ? "—" : Math.abs(b) >= 1000 ? `$${(b / 1000).toFixed(2)}T` : `$${b.toFixed(Math.abs(b) >= 10 ? 0 : 1)}B`;
const fmtSigned = (v: number | null | undefined, d = 1, suf = "") =>
  v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}${suf}`;
const tone = (v: number | null | undefined) => (v == null ? "text-white" : v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "text-white");
const ruleText = (r?: Rule, unit = "") => (r ? `${r[0]} ${r[1]}${unit ? ` ${unit}` : ""}` : "—");
const titleCase = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error(`${url} ${r.status}`);
  return r.json();
}

function Section({ title, tip, right, children }: { title: string; tip?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="border border-[#d4af37]/20 bg-zinc-950 rounded-md">
      <div className="flex items-center justify-between gap-2 px-2 py-1 bg-zinc-800 rounded-t-md">
        <DataTip tip={tip}><span className="text-[11px] font-bold uppercase tracking-wide text-white">{title}</span></DataTip>
        {right}
      </div>
      <div className="p-1.5">{children}</div>
    </div>
  );
}

// ── Unified read ────────────────────────────────────────────────────────────────────────────────

const TIER_CHIP = { tested: "bg-emerald-700 text-white", untested: "bg-zinc-700 text-white", context: "bg-zinc-800 text-white", hint: "bg-amber-800 text-white", avoid: "bg-red-800 text-white" } as const;

function ReadStrip({ t, onJump }: { t: ThemesResp; onJump: (tab: MacroTab) => void }) {
  const r = t.read;
  const active = r.playbook.filter((p) => p.active);
  return (
    <div className="border border-[#d4af37]/20 bg-zinc-950 rounded-md px-2 py-1.5 space-y-1 text-[11px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {r.layers.map((l) => (
          <DataTip key={l.key} tip={l.why}>
            <button onClick={() => l.tab !== "themes" && onJump(l.tab as MacroTab)} className="flex items-center gap-1 text-white hover:text-[#d4af37]">
              <span className={cn("px-1 rounded text-[9px] font-bold uppercase", TIER_CHIP[l.tier])}>{l.tier}</span>
              <span className="font-semibold">{l.label}:</span><span>{l.readout}</span>
            </button>
          </DataTip>
        ))}
        <DataTip tip={`Scenario odds from ${t.scenarioSource}: A + D + half of B.`}>
          <span className="text-white"><span className="font-semibold">P(S&P up 12 m):</span> {(r.pUp12m * 100).toFixed(0)} %</span>
        </DataTip>
        <span className="ml-auto text-white">
          Registry {formatMdYy(t.updated)}{t.registryAgeDays > 14 && <span className="text-amber-400"> · stale {t.registryAgeDays} d</span>}
        </span>
      </div>
      <div className="flex flex-col gap-0.5">
        {active.map((p) => (
          <DataTip key={p.id} tip={p.evidence}>
            <div className="flex items-start gap-1.5 text-white">
              <span className={cn("px-1 rounded text-[9px] font-bold uppercase shrink-0", TIER_CHIP[p.tier])}>{p.tier}</span>
              <span>{p.do}</span>
            </div>
          </DataTip>
        ))}
      </div>
    </div>
  );
}

// ── Themes grid ─────────────────────────────────────────────────────────────────────────────────

function SignpostRows({ th, onJump }: { th: Theme; onJump: (tab: MacroTab) => void }) {
  return (
    <tr>
      <td colSpan={8} className="px-2 pb-2 pt-1 bg-black/60">
        <div className="text-[11px] text-amber-50 mb-1">{th.thesis} <span className="text-white">Claude: {th.view.text}</span></div>
        <div className={GRID_WRAP}>
          <table className="w-full border-collapse">
            <thead><tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-left")}>Signpost</th>
              <th className={cn(GRID_TH, "text-right")}>Now</th>
              <th className={cn(GRID_TH, "text-right")}>Bull if</th>
              <th className={cn(GRID_TH, "text-right")}>Bear if</th>
              <th className={cn(GRID_TH, "text-center")}>Status</th>
              <th className={cn(GRID_TH, "text-right")}>As of</th>
              <th className={cn(GRID_TH, "text-left")}>Source</th>
            </tr></thead>
            <tbody>
              {th.signposts.map((s, i) => (
                <tr key={s.id} className={gridRow(i)}>
                  <td className={cn(GRID_TD, "text-left")}>
                    <DataTip tip={[s.detail, s.note].filter(Boolean).join(" · ") || undefined}><span>{s.label}</span></DataTip>
                  </td>
                  <td className={cn(GRID_TD, "text-right font-semibold")}>{s.current == null ? "—" : `${s.current.toFixed(Math.abs(s.current) >= 100 ? 0 : 2)}${s.unit ? ` ${s.unit}` : ""}`}</td>
                  <td className={cn(GRID_TD, "text-right text-amber-50")}>{ruleText(s.bull_if)}</td>
                  <td className={cn(GRID_TD, "text-right text-amber-50")}>{ruleText(s.bear_if)}</td>
                  <td className={cn(GRID_TD, "text-center")}><span className={cn("px-1.5 rounded text-[10px] font-bold", STATUS_CHIP[s.status])}>{s.status}</span></td>
                  <td className={cn(GRID_TD, "text-right")}>{s.asOf ? formatMdYy(s.asOf.slice(0, 10)) : "—"}</td>
                  <td className={cn(GRID_TD, "text-left")}>
                    {s.tab && s.tab !== "themes"
                      ? <button className="underline decoration-[#d4af37]/50 hover:text-[#d4af37]" onClick={() => onJump(s.tab as MacroTab)}>{titleCase(s.tab)}</button>
                      : <span className="text-amber-50">{s.kind}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="text-[10px] text-white mt-1">Refs: {th.refs.join(" · ")}</div>
      </td>
    </tr>
  );
}

function ThemesGrid({ t, onJump }: { t: ThemesResp; onJump: (tab: MacroTab) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section title="Key themes" tip="Cyclical (rates, Fed, credit, earnings, fiscal), secular (AI capex, power, policy supply) and event themes. Each signpost reads data other Macro tabs already load; thresholds are judgment calls, graded on the check date (theme_snapshots + market-views LOG). Click a row for signposts.">
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead><tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left")}>Theme</th>
            <th className={cn(GRID_TH, "text-left")}>Horizon</th>
            <th className={cn(GRID_TH, "text-center")}>Claude view</th>
            <th className={cn(GRID_TH, "text-center")}>Signposts</th>
            <th className={cn(GRID_TH, "text-center")}>Lean</th>
            <th className={cn(GRID_TH, "text-right")}>Weight</th>
            <th className={cn(GRID_TH, "text-right")}>Check</th>
            <th className={cn(GRID_TH, "text-left")}>Flag</th>
          </tr></thead>
          <tbody>
            {t.themes.map((th, i) => (
              <Fragment key={th.id}>
                <tr className={cn(gridRow(i), "cursor-pointer")} onClick={() => setOpen(open === th.id ? null : th.id)}>
                  <td className={cn(GRID_TD, "text-left font-semibold")}>
                    <span className="text-[#d4af37] mr-1">{open === th.id ? "▾" : "▸"}</span>{th.name}
                  </td>
                  <td className={cn(GRID_TD, "text-left")}>{HORIZON_LABEL[th.horizon]}</td>
                  <td className={cn(GRID_TD, "text-center")}>
                    <span className={cn("px-1.5 rounded text-[10px] font-bold", STATUS_CHIP[th.view.stance])}>{th.view.stance} {(th.view.p * 100).toFixed(0)} %</span>
                  </td>
                  <td className={cn(GRID_TD, "text-center")}>
                    <span className="text-emerald-400">{th.bull}↑</span> <span className="text-red-400">{th.bear}↓</span> <span>{th.neutral}=</span>
                    {th.missing > 0 && <span className="text-amber-400"> {th.missing}?</span>}
                  </td>
                  <td className={cn(GRID_TD, "text-center")}>
                    <span className={cn("px-1.5 rounded text-[10px] font-bold", STATUS_CHIP[(th.lean as Status)] ?? STATUS_CHIP.missing)}>{th.lean}</span>
                  </td>
                  <td className={cn(GRID_TD, "text-right")}>{th.weight}</td>
                  <td className={cn(GRID_TD, "text-right")}>{formatMdYy(th.view.check)}</td>
                  <td className={cn(GRID_TD, "text-left")}>
                    {th.divergence && <DataTip tip="Claude's stance disagrees with its own signposts → re-check the view next thesis session."><span className="text-amber-400 font-semibold">view ≠ data</span></DataTip>}
                    {th.checkDue && <span className="text-amber-400 font-semibold ml-1">grade due</span>}
                  </td>
                </tr>
                {open === th.id && <SignpostRows th={th} onJump={onJump} />}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function ScenariosGrid({ t }: { t: ThemesResp }) {
  return (
    <Section title="Scenarios (12 m)" tip={`Judgment-weighted from historical analogs: ${t.scenarioSource}. "Pointing" = how many of the scenario's signposts point its way today (context, not a re-weight).`}>
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead><tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left")}>Scenario</th>
            <th className={cn(GRID_TH, "text-left")}>Path</th>
            <th className={cn(GRID_TH, "text-right")}>S&P 12 m</th>
            <th className={cn(GRID_TH, "text-right")}>Prob</th>
            <th className={cn(GRID_TH, "text-right")}>Pointing</th>
          </tr></thead>
          <tbody>
            {t.scenarios.map((s, i) => (
              <tr key={s.id} className={gridRow(i)}>
                <td className={cn(GRID_TD, "text-left font-semibold")}>{s.id}. {s.name}</td>
                <td className={cn(GRID_TD, "text-left text-amber-50")}>{s.path}</td>
                <td className={cn(GRID_TD, "text-right")}>{s.spx_12m}</td>
                <td className={cn(GRID_TD, "text-right font-semibold")}>{(s.p * 100).toFixed(0)} %</td>
                <td className={cn(GRID_TD, "text-right")}>{s.pointing}/{s.signals}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

// ── Money flows ─────────────────────────────────────────────────────────────────────────────────

function FlowTable<T extends Stats>({ rows, w, name, extra }: {
  rows: T[]; w: Win; name: (r: T) => React.ReactNode; extra?: { head: string; cell: (r: T) => React.ReactNode };
}) {
  const chg = (r: Stats) => r[`chg${w}` as const];
  const pct = (r: Stats) => r[`pct${w}` as const];
  return (
    <div className={GRID_WRAP}>
      <table className="w-full border-collapse">
        <thead><tr className={GRID_HEADER}>
          <th className={cn(GRID_TH, "text-left")}>Name</th>
          <th className={cn(GRID_TH, "text-right")}>Cap</th>
          <th className={cn(GRID_TH, "text-right")}>Δ $ {w}</th>
          <th className={cn(GRID_TH, "text-right")}>Δ % {w}</th>
          <th className={cn(GRID_TH, "text-right")}>1w / 1m / 3m %</th>
          {extra && <th className={cn(GRID_TH, "text-left")}>{extra.head}</th>}
        </tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={gridRow(i)}>
              <td className={cn(GRID_TD, "text-left font-semibold")}>{name(r)}</td>
              <td className={cn(GRID_TD, "text-right")}>{fmtB(r.cap)}</td>
              <td className={cn(GRID_TD, "text-right font-semibold", tone(chg(r)))}>{chg(r) == null ? "—" : `${chg(r)! >= 0 ? "+" : "−"}${fmtB(Math.abs(chg(r)!))}`}</td>
              <td className={cn(GRID_TD, "text-right", tone(pct(r)))}>{fmtSigned(pct(r), 1, " %")}</td>
              <td className={cn(GRID_TD, "text-right")}>
                <span className={tone(r.pct1w)}>{fmtSigned(r.pct1w, 1)}</span> / <span className={tone(r.pct1m)}>{fmtSigned(r.pct1m, 1)}</span> / <span className={tone(r.pct3m)}>{fmtSigned(r.pct3m, 1)}</span>
              </td>
              {extra && <td className={cn(GRID_TD, "text-left")}>{extra.cell(r)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const movers = (top: Mover[]) => top.map((m) => (
  <span key={m.ticker} className="mr-2 whitespace-nowrap">{m.ticker} <span className={tone(m.chg)}>{m.chg >= 0 ? "+" : "−"}{fmtB(Math.abs(m.chg))}</span></span>
));

function MoneyWeb({ web }: { web: NonNullable<FlowsResp["web"]> }) {
  const W = 620, H = 470, cx = W / 2, cy = H / 2;
  const layout = useMemo(() => {
    const deg = new Map<string, number>();
    for (const e of web.edges) for (const k of [e.from, e.to]) deg.set(k, (deg.get(k) ?? 0) + 1);
    const ids = [...web.nodes].sort((a, b) => (deg.get(b.id) ?? 0) - (deg.get(a.id) ?? 0)).map((n) => n.id);
    const inner = ids.slice(0, 3), outer = ids.slice(3);
    const pos = new Map<string, { x: number; y: number }>();
    inner.forEach((id, i) => { const a = (i / inner.length) * 2 * Math.PI - Math.PI / 2; pos.set(id, { x: cx + 85 * Math.cos(a), y: cy + 85 * Math.sin(a) }); });
    outer.forEach((id, i) => { const a = (i / outer.length) * 2 * Math.PI - Math.PI / 2 + 0.2; pos.set(id, { x: cx + 200 * Math.cos(a), y: cy + 190 * Math.sin(a) }); });
    const maxV = Math.max(...web.nodes.map((n) => n.value_b ?? 0), 1);
    const rad = new Map(web.nodes.map((n) => [n.id, 6 + 30 * Math.sqrt((n.value_b ?? 0) / maxV)]));
    return { pos, rad };
  }, [web, cx, cy]);
  const [hover, setHover] = useState<string | null>(null);
  return (
    <div>
      <div className="flex flex-wrap gap-3 text-[10px] text-white mb-1">
        {Object.entries(EDGE).map(([k, e]) => (
          <span key={k} className="flex items-center gap-1">
            <svg width="22" height="6"><line x1="0" y1="3" x2="22" y2="3" stroke={e.color} strokeWidth="2" strokeDasharray={e.dash} /></svg>{e.label}
          </span>
        ))}
        <span>○ dashed = private (last round)</span>
        <span className="ml-auto">Deals as of {formatMdYy(web.updated)} · size = market cap</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-h-[480px]" role="img" aria-label="AI money web: who invests in, buys from and rents compute from whom">
        <defs>
          {Object.entries(EDGE).map(([k, e]) => (
            <marker key={k} id={`arr-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={e.color} />
            </marker>
          ))}
        </defs>
        {web.edges.map((e, i) => {
          const a = layout.pos.get(e.from), b = layout.pos.get(e.to);
          if (!a || !b) return null;
          const st = EDGE[e.type as keyof typeof EDGE] ?? EDGE.investment;
          const rb = layout.rad.get(e.to) ?? 8;
          const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
          const ex = b.x - (dx / len) * (rb + 3), ey = b.y - (dy / len) * (rb + 3);
          const mx = (a.x + ex) / 2 - dy * 0.12, my = (a.y + ey) / 2 + dx * 0.12;
          const dim = hover && hover !== e.from && hover !== e.to;
          return (
            <path key={i} d={`M${a.x},${a.y} Q${mx},${my} ${ex},${ey}`} fill="none" stroke={st.color} strokeWidth={dim ? 1 : 2}
              strokeDasharray={st.dash} opacity={dim ? 0.15 : 0.85} markerEnd={`url(#arr-${e.type})`}>
              <title>{`${e.from} → ${e.to} · ${st.label}${e.amount_b != null ? ` · $${e.amount_b}B` : ""} · ${e.date}${e.note ? ` · ${e.note}` : ""}`}</title>
            </path>
          );
        })}
        {web.nodes.map((n) => {
          const p = layout.pos.get(n.id)!, r = layout.rad.get(n.id)!;
          return (
            <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} className="cursor-default">
              <circle cx={p.x} cy={p.y} r={r + 6} fill="transparent" />
              <circle cx={p.x} cy={p.y} r={r} fill="#18181b" stroke="#d4af37" strokeWidth={hover === n.id ? 2.5 : 1.5} strokeDasharray={n.public ? "" : "3 2"} />
              <text x={p.x} y={p.y - 1} textAnchor="middle" fontSize="10" fontWeight="700" fill="#ffffff">{n.id}</text>
              <text x={p.x} y={p.y + 10} textAnchor="middle" fontSize="9" fill="#fef3c7">{fmtB(n.value_b)}</text>
              <title>{`${n.id}: ${fmtB(n.value_b)}${n.public ? ` market cap${n.pct1m != null ? `, ${fmtSigned(n.pct1m, 1, " %")} 1 m` : ""}` : ` last round (${n.as_of ?? "?"})${n.note ? `, ${n.note}` : ""}`}`}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function DeficitBars({ monthly }: { monthly: FlowsResp["gov"]["monthly"] }) {
  const rows = monthly.slice(-24);
  if (!rows.length) return null;
  const W = 620, H = 150, pad = 18;
  const max = Math.max(...rows.map((r) => Math.abs(r.deficit)), 1);
  const bw = (W - 2 * pad) / rows.length;
  const zero = H / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H + 14}`} className="w-full" role="img" aria-label="Monthly federal deficit, last 24 months">
      <line x1={pad} x2={W - pad} y1={zero} y2={zero} stroke="#52525b" strokeWidth="1" />
      {rows.map((r, i) => {
        const h = (Math.abs(r.deficit) / max) * (H / 2 - 6);
        const x = pad + i * bw + 1;
        const up = r.deficit >= 0;
        return (
          <g key={r.month}>
            <rect x={x} y={up ? zero - h : zero} width={Math.max(bw - 2, 1)} height={Math.max(h, 1)} rx="2"
              fill={up ? "#dc2626" : "#16a34a"} opacity="0.85" />
            <rect x={x - 1} y={0} width={bw} height={H} fill="transparent">
              <title>{`${formatMdYy(r.month)}: ${up ? "deficit" : "surplus"} ${fmtB(Math.abs(r.deficit))} · outlays ${fmtB(r.outlays)} · receipts ${fmtB(r.receipts)}`}</title>
            </rect>
            {i % 3 === 0 && <text x={x + bw / 2} y={H + 11} textAnchor="middle" fontSize="9" fill="#ffffff">{r.month.slice(2, 7)}</text>}
          </g>
        );
      })}
      <text x={pad} y={10} fontSize="9" fill="#ffffff">▲ deficit (cash into economy)</text>
      <text x={pad} y={H - 2} fontSize="9" fill="#ffffff">▼ surplus (tax months)</text>
    </svg>
  );
}

function GovFlows({ gov }: { gov: FlowsResp["gov"] }) {
  const weeks = gov.weekly.slice(-8).reverse();
  return (
    <Section title="Government cash flows" tip="Treasury Fiscal Data (free): Monthly Treasury Statement + Daily Treasury Statement. Deficit = spending − taxes (cash pumped into the economy). Net borrow = new Treasury debt sold minus redeemed (supply the market must absorb). TGA rise = cash drained from bank reserves. Net liquidity (Fed − TGA − RRP) lives in Liquidity.">
      <div className="text-[11px] text-white mb-1">
        <span className="font-semibold">Deficit, last 12 months:</span> {fmtB(gov.deficit12m)}
      </div>
      <DeficitBars monthly={gov.monthly} />
      <div className={cn(GRID_WRAP, "mt-1")}>
        <table className="w-full border-collapse">
          <thead><tr className={GRID_HEADER}>
            {["Week of", "Spending", "Taxes", "Deficit", "Net borrow", "TGA", "Interest", "Defense"].map((h, i) => (
              <th key={h} className={cn(GRID_TH, i ? "text-right" : "text-left")}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {weeks.map((w, i) => (
              <tr key={w.week} className={gridRow(i)}>
                <td className={cn(GRID_TD, "text-left")}>{formatMdYy(w.week)}</td>
                <td className={cn(GRID_TD, "text-right")}>{fmtB(w.spend)}</td>
                <td className={cn(GRID_TD, "text-right")}>{fmtB(w.receipts)}</td>
                <td className={cn(GRID_TD, "text-right font-semibold", w.deficit > 0 ? "text-emerald-400" : "text-red-400")}>{fmtB(w.deficit)}</td>
                <td className={cn(GRID_TD, "text-right")}>{fmtB(w.net_borrow)}</td>
                <td className={cn(GRID_TD, "text-right")}>{fmtB(w.tga)}</td>
                <td className={cn(GRID_TD, "text-right")}>{fmtB(w.interest)}</td>
                <td className={cn(GRID_TD, "text-right")}>{fmtB(w.defense)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function MoneyFlows() {
  const [w, setW] = useState<Win>("1m");
  const { data, isLoading } = useQuery<FlowsResp>({
    queryKey: ["macro-money-flows", w], queryFn: () => getJson(`/api/macro/money-flows?w=${w}`),
    staleTime: 15 * 60_000, refetchOnWindowFocus: false,
  });
  const m = data?.market;
  const toggle = (
    <div className="inline-flex rounded border border-[#d4af37]/30 overflow-hidden text-[10px] font-bold">
      {(["1w", "1m", "3m"] as Win[]).map((x) => (
        <button key={x} onClick={() => setW(x)} className={cn("px-2 py-0.5", x === w ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white")}>{x}</button>
      ))}
    </div>
  );
  if (isLoading || !data) return <Section title="Money flows" right={toggle}><div className="text-[11px] text-white">Loading…</div></Section>;
  return (
    <>
      {m && (
        <Section title="Money flows: market cap by sector" right={toggle}
          tip={`Market-cap change ($) across our ${m.total.n}-name universe (close × shares outstanding, LSEG all-class shares; constant-shares approximation). Sector = peer-group taxonomy. Prices as of ${m.asOf}.`}>
          <div className="text-[11px] text-white mb-1">
            <span className="font-semibold">Universe:</span> {fmtB(m.total.cap)} · {w}{" "}
            <span className={tone(m.total[`chg${w}`])}>{m.total[`chg${w}`]! >= 0 ? "+" : "−"}{fmtB(Math.abs(m.total[`chg${w}`] ?? 0))} ({fmtSigned(m.total[`pct${w}`], 2, " %")})</span>
            <span className="ml-2">as of {formatMdYy(m.asOf)}</span>
          </div>
          <FlowTable rows={m.sectors} w={w} name={(r) => titleCase(r.sector)}
            extra={{ head: "Biggest movers", cell: (r) => movers(r.top) }} />
        </Section>
      )}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        {m && (
          <Section title="Key players" tip="Top 25 names by market cap. Share = slice of the universe.">
            <FlowTable rows={m.players} w={w} name={(r) => r.ticker}
              extra={{ head: "Share", cell: (r) => `${(r.share * 100).toFixed(1)} %` }} />
          </Section>
        )}
        {m && (
          <Section title="Theme baskets" tip="Baskets from research/market-views/themes.json (same names the theme signposts use).">
            <FlowTable rows={m.baskets} w={w} name={(r) => `${titleCase(r.basket)} (${r.n})`}
              extra={{ head: "Biggest movers", cell: (r) => movers(r.top) }} />
          </Section>
        )}
      </div>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-2">
        {data.web && (
          <Section title="AI money web" tip="Announced deals between AI players: investments, chip purchases, cloud/compute contracts, venture stakes. Headline $ often multi-year or 'up to'. Hover a node to isolate its links; hover a line for the deal. Source: research/market-views/ai_deals.json (Claude updates in thesis sessions).">
            <MoneyWeb web={data.web} />
          </Section>
        )}
        <GovFlows gov={data.gov} />
      </div>
    </>
  );
}

export function KeyThemesTab({ onJump }: { onJump: (tab: MacroTab) => void }) {
  const { data, isLoading, isError } = useQuery<ThemesResp>({
    queryKey: ["macro-themes"], queryFn: () => getJson("/api/macro/themes"),
    staleTime: 15 * 60_000, refetchOnWindowFocus: false,
  });
  return (
    <>
      {isLoading && <div className="text-[11px] text-white">Loading themes…</div>}
      {isError && <div className="text-[11px] text-red-400">Themes failed to load.</div>}
      {data && (
        <>
          <ReadStrip t={data} onJump={onJump} />
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
            <div className="xl:col-span-2"><ThemesGrid t={data} onJump={onJump} /></div>
            <ScenariosGrid t={data} />
          </div>
        </>
      )}
      <MoneyFlows />
    </>
  );
}
