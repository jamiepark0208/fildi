/**
 * A372 § 4 chart — market cash target over time (step line) + each account's actual cash mix F/(F+P) per holdings snapshot.
 * Data: /api/pm/book → book.cash_history (pm_book.cash_history). Debt days (cash < 0) have no mix: drawn as a red dot on 0 %,
 * tooltip shows the debt. Target before the first issued day is the same rule replayed (counterfactual, dashed in legend text).
 */
import { CartesianGrid, ComposedChart, Line, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from "recharts";

export type CashHistory = {
  target: { d: string; target: number; regime: string; issued: boolean }[];
  accounts: Record<string, { d: string; mix: number | null; F: number; P: number; debt: number | null; basis: string }[]>;
  note?: string;
  error?: string;
};

const TIP = "rounded-md border border-[#d4af37]/35 bg-zinc-950 px-2.5 py-2 shadow-2xl shadow-black/80 text-[10px] text-zinc-100";
const COLORS = ["#38bdf8", "#a78bfa", "#f472b6"];
const money = (v: number) => `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const md = (iso: string) => { const [, m, d] = iso.split("-"); return `${Number(m)}/${Number(d)}`; };

type Row = { d: string; target?: number; issued?: boolean; regime?: string } & Record<string, unknown>;

export function CashTargetHistory({ h }: { h?: CashHistory | null }) {
  if (!h || h.error || !h.target.length) return null;
  const names = Object.keys(h.accounts);
  const byDay = new Map<string, Row>();
  const row = (d: string) => byDay.get(d) ?? (byDay.set(d, { d }), byDay.get(d)!);
  for (const t of h.target) Object.assign(row(t.d), { target: t.target * 100, issued: t.issued, regime: t.regime });
  // One line segment per run of snapshots (gap > 10 days or a debt/no-mix day starts a new run), joined across target-only days.
  const segs: { key: string; color: string }[] = [];
  names.forEach((n, i) => {
    let seg = -1, prev: string | null = null;
    for (const p of h.accounts[n]) {
      const r = row(p.d);
      r[`${n}_p`] = p;
      r[`${n}_debt`] = p.mix == null && p.debt ? 0 : null;
      if (p.mix == null) { prev = null; continue; }
      if (!prev || (Date.parse(p.d) - Date.parse(prev)) / 864e5 > 10) {
        seg += 1;
        segs.push({ key: `${n}_s${seg}`, color: COLORS[i % 3] });
      }
      r[`${n}_s${seg}`] = p.mix * 100;
      prev = p.d;
    }
  });
  const withMix = names.filter((n) => h.accounts[n].some((p) => p.mix != null));
  const data = [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d));
  const firstIssued = h.target.find((t) => t.issued)?.d;

  return (
    <div className="rounded border border-white/10 bg-black/30 px-1 pt-1">
      <div className="flex flex-wrap items-center gap-x-3 text-[10px] text-white px-1">
        <span className="font-semibold">Cash share over time</span>
        <span><span className="text-[#d4af37]">━</span> market target{firstIssued ? ` (issued from ${md(firstIssued)}; earlier = rule replayed)` : " (rule replayed)"}</span>
        {withMix.map((n) => <span key={n}><span style={{ color: COLORS[names.indexOf(n) % 3] }}>━</span> {n} mix</span>)}
        <span><span className="text-red-400">●</span> margin debt, no reserve ({names.filter((n) => !withMix.includes(n)).join(", ") || "any account"})</span>
      </div>
      <div className="h-[170px]">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
            <CartesianGrid stroke="#ffffff14" vertical={false} />
            <XAxis dataKey="d" tickFormatter={md} tick={{ fill: "#e4e4e7", fontSize: 9 }} minTickGap={24} />
            <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tickFormatter={(v) => `${v}%`} tick={{ fill: "#e4e4e7", fontSize: 9 }} />
            <Tooltip content={<HistTip names={names} />} />
            <Line dataKey="target" type="stepAfter" stroke="#d4af37" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
            {segs.map((s) => (
              <Line key={s.key} dataKey={s.key} stroke={s.color} strokeWidth={1.5} dot={{ r: 1.5 }} connectNulls isAnimationActive={false} />
            ))}
            {names.map((n) => (
              <Scatter key={`${n}-debt`} dataKey={`${n}_debt`} fill="#f87171" shape="circle" isAnimationActive={false} />
            ))}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function HistTip({ active, payload, names }: { active?: boolean; payload?: { payload: Row }[]; names: string[] }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className={TIP}>
      <div className="font-semibold">{r.d}</div>
      {r.target != null && <div>Target {r.target.toFixed(0)}% · {r.regime}{r.issued ? "" : " (replayed)"}</div>}
      {names.map((n) => {
        const p = r[`${n}_p`] as CashHistory["accounts"][string][number] | undefined;
        if (!p) return null;
        return (
          <div key={n}>
            {n}: {p.mix == null ? (p.debt ? `debt ${money(p.debt)}` : "no puts, no cash") : `${(p.mix * 100).toFixed(0)}%`}
            {" "}· cash {money(p.F)} · puts {money(p.P)}
          </div>
        );
      })}
    </div>
  );
}
