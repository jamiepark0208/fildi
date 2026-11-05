import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { SUI } from "./settings-ui";
import { getDefaultIndicators, setDefaultIndicator } from "@/lib/indicator-defaults";

type Pair = { n: number; days: number; sig: number; rnd: number; lift: number; t: number; both: boolean; verdict: string };
type Cell = {
  kind: string; tf: string; n: number; days: number | null; verdict: string; needMore: number | null;
  pWin: number | null; pWinLo: number | null; pWinHi: number | null; randomWinPct: number | null;
  bestStructure: string | null; structures: Record<string, Pair> | null;
  oldHitPct: number | null; oldPlaceboHitPct: number | null; gradedThrough: string | null;
};
type Ind = { id: string; label: string; version: number; title: string; source: { url: string; author: string }; timeframes: string[]; graded: boolean; cells: Cell[] };

const FAMILIES: { key: string; label: string; unit: string }[] = [
  { key: "direction", label: "Direction", unit: "% / trade" },
  { key: "bracket", label: "Bracket", unit: "pts" },
  { key: "vol", label: "Vol |move|", unit: "%" },
  { key: "premium", label: "Premium", unit: "pts" },
];
const f1 = (v: number | null | undefined) => (v == null ? "–" : v.toFixed(1));
const chip = (v: string) =>
  v === "likely useful" ? "text-emerald-300 border-emerald-400/50"
  : v === "likely worse than random" ? "text-red-300 border-red-400/50"
  : v === "likely noise" ? "text-amber-100 border-zinc-500/60" : "text-amber-200 border-amber-400/40";
const Chip = ({ v }: { v: string }) => <span className={`inline-block rounded border px-1.5 text-[10px] ${chip(v)}`}>{v}</span>;
const day = (s: string | null) => (s ? s.slice(0, 10) : "–");

function Detail({ ind }: { ind: Ind }) {
  const rows = ind.cells.filter((c) => !(c.kind === "ALL" && c.tf === "ALL"));
  if (!rows.length) return <div className={SUI.muted}>No graded signals yet.</div>;
  return (
    <table className={SUI.table}>
      <thead className={SUI.thead}>
        <tr>
          <th className={SUI.th}>Kind</th><th className={SUI.th}>TF</th><th className={SUI.thRight}>n</th>
          <th className={SUI.thRight}>P(win)</th>
          {FAMILIES.map((f) => <th key={f.key} className={SUI.th} title={`${f.label} (${f.unit}): signal vs random, lift, t, both halves`}>{f.label}</th>)}
          <th className={SUI.th} title="Old ATR placebo test">Old ATR test</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.kind + c.tf} className={SUI.tr}>
            <td className={SUI.td}>{c.kind}</td><td className={SUI.td}>{c.tf}</td>
            <td className={`${SUI.td} text-right tabular-nums`}>{c.n}</td>
            <td className={`${SUI.td} text-right tabular-nums`}>{f1(c.pWin)}</td>
            {FAMILIES.map((f) => {
              const p = c.structures?.[f.key];
              return (
                <td key={f.key} className={`${SUI.td} tabular-nums whitespace-nowrap`}>
                  {p ? <>{f1(p.sig)} vs {f1(p.rnd)} · {p.lift >= 0 ? "+" : ""}{f1(p.lift)} · t {f1(p.t)}{p.both ? " ✓" : ""} <Chip v={p.verdict} /></> : "–"}
                </td>
              );
            })}
            <td className={`${SUI.tdMuted} text-[10px] tabular-nums`}>{c.oldHitPct == null ? "–" : `${f1(c.oldHitPct)} vs ${f1(c.oldPlaceboHitPct)}`}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function IndicatorsTab() {
  const { data, isLoading, error } = useQuery<{ indicators: Ind[] }>({
    queryKey: ["indicator-scorecard"],
    queryFn: async () => {
      const r = await fetch("/api/indicators/scorecard", { credentials: "include" });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  const [open, setOpen] = useState<string | null>(null);
  const [defs, setDefs] = useState<string[]>(() => getDefaultIndicators());

  return (
    <div className={SUI.panel}>
      <div>
        <div className={SUI.title}>Indicators</div>
        <div className={SUI.sub}>Stock-path test, vs vol-matched random entries; structures over 60 min. Option-priced test = S152 (A334).</div>
      </div>
      {isLoading && <div className={SUI.muted}>Loading…</div>}
      {error && <div className="text-red-300 text-xs">Scorecard failed to load.</div>}
      {data && (
        <div className={SUI.tableWrap}>
          <table className={SUI.table}>
            <thead className={SUI.thead}>
              <tr>
                <th className={SUI.th} />
                <th className={SUI.th}>Indicator</th><th className={SUI.th}>Verdict</th>
                <th className={SUI.th} title="Calibrated P(trade wins) with 90% band vs random entries">Confidence</th>
                <th className={SUI.th}>Best structure</th>
                <th className={SUI.thRight}>n</th><th className={SUI.thRight}>Days</th>
                <th className={SUI.th}>Graded</th><th className={SUI.th}>Source</th>
                <th className={SUI.th} title="On by default in both charts' Indicators menu">Default</th>
              </tr>
            </thead>
            <tbody>
              {data.indicators.map((ind) => {
                const all = ind.cells.find((c) => c.kind === "ALL" && c.tf === "ALL");
                const isOpen = open === ind.id;
                return (
                  <Fragment key={ind.id}>
                    <tr className={`${SUI.tr} cursor-pointer`} onClick={() => setOpen(isOpen ? null : ind.id)}>
                      <td className={SUI.td}>{isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}</td>
                      <td className={SUI.td} title={ind.title}>{ind.label} <span className="text-amber-100">v{ind.version} · {ind.timeframes.join("/")}</span></td>
                      <td className={SUI.td}>{all ? <Chip v={all.verdict} /> : <span className={SUI.muted}>not graded</span>}</td>
                      <td className={`${SUI.td} tabular-nums whitespace-nowrap`}>
                        {all?.pWin != null ? <>{f1(all.pWin)}% <span className="text-amber-100">({f1(all.pWinLo)}–{f1(all.pWinHi)}) vs {f1(all.randomWinPct)}</span></> : "–"}
                      </td>
                      <td className={SUI.td}>{all ? (all.bestStructure ?? "no edge yet") : "–"}</td>
                      <td className={`${SUI.td} text-right tabular-nums`}>{all?.n ?? "–"}</td>
                      <td className={`${SUI.td} text-right tabular-nums`}>{all?.days ?? "–"}</td>
                      <td className={SUI.tdMuted}>{day(all?.gradedThrough ?? null)}</td>
                      <td className={SUI.td}><a href={ind.source.url} target="_blank" rel="noreferrer" className="underline" onClick={(e) => e.stopPropagation()}>{ind.source.author}</a></td>
                      <td className={SUI.td} onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" checked={defs.includes(ind.id)} onChange={(e) => setDefs(setDefaultIndicator(ind.id, e.target.checked))} />
                      </td>
                    </tr>
                    {isOpen && <tr><td colSpan={10} className="p-2 bg-zinc-950"><Detail ind={ind} /></td></tr>}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
