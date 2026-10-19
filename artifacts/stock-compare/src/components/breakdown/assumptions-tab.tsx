/**
 * Breakdown › Assumptions — what this stock's fair value rests on, and every change to it.
 * Base = shared rules (same for every stock; versioned fv-*) + this stock's cohort (peer group) + its data inputs.
 * Judgement = logged overrides (reason, source, who, expiry), shown as a separate Adjusted value. API: routes/fair-value-assumptions.ts.
 */
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { History, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { FvVsStreetChart } from "./fv-vs-street-chart";

type Unit = "usd" | "pct" | "usd_total" | "count" | "x";
type Input = { field: string; label: string; unit: Unit; source: string; value: number | null; lastChanged: string | null; overridable: boolean; versions: number };
type Row = {
  id: number; scope: "ticker" | "peer_group"; scope_key: string; field: string; value: number; reason: string; source: string | null;
  status: "proposed" | "active" | "retired" | "rejected"; created_by: string | null; created_at: string; decided_at: string | null;
  decision_note: string | null; expires_at: string | null;
};
type Sheet = {
  shared: { version: string; changedAt: string | null; rationale: string | null; params: Record<string, unknown> };
  cohort: { id: string; name: string; scoring_mode: string; members: number } | null;
  inputs: Input[]; inputsSince: string | null; assumptions: Row[];
  latest: { as_of: string; price: number | null; fair_value: number | null; adjusted_fair_value: number | null; confidence: string | null; mode: string; model_version: string; implied_growth?: number | null } | null;
  history: { as_of: string; price: number | null; fair_value: number | null; adjusted_fair_value: number | null }[];
  streetPt?: number | null;
  streetImpliedGrowth?: number | null;
  growthCap?: number | null;
  furthestVoters?: { name: string; value: number; gapPct: number }[];
};
type FieldHistory = { changes: { date: string; value: number | null }[]; overrides: Row[] };

export function fmtUnit(v: number | null | undefined, unit: Unit): string {
  if (v == null || !Number.isFinite(v)) return "—";
  switch (unit) {
    case "usd": return `$${v.toFixed(2)}`;
    case "pct": return `${(v * 100).toFixed(1)}%`;
    case "usd_total": return Math.abs(v) >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : `$${(v / 1e6).toFixed(0)}M`;
    case "count": return `${(v / 1e6).toFixed(1)}M`;
    default: return v.toFixed(2);
  }
}
const pct = (v: unknown) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "—");
const range = (v: unknown, f: (x: number) => string) => (Array.isArray(v) ? `${f(v[0])}–${f(v[1])}` : "—");
const STATUS: Record<Row["status"], string> = {
  active: "text-emerald-300 border-emerald-500/40", proposed: "text-amber-300 border-amber-400/40",
  retired: "text-amber-200/40 border-amber-200/10", rejected: "text-red-300/60 border-red-500/20",
};
const COHORT_LABEL: Record<string, string> = { equityRiskPremium: "ERP", terminalGrowth: "Terminal growth", growthCap: "Growth cap", growthFloor: "Growth floor" };

function OverrideForm({ ticker, field, unit, onDone }: { ticker: string; field: string; unit: Unit; onDone: () => void }) {
  const qc = useQueryClient();
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const m = useMutation({
    mutationFn: async (status: "proposed" | "active") => {
      // the form takes % for pct fields and $M for totals; the API stores model units
      const raw = Number(value);
      const v = unit === "pct" ? raw / 100 : unit === "usd_total" ? raw * 1e6 : raw;
      const r = await fetch("/api/fair-value/assumptions", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: "ticker", scopeKey: ticker, field, value: v, reason, source: source || "manual", status }),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["fv-assumptions", ticker] }); onDone(); },
  });
  const hint = unit === "pct" ? "%" : unit === "usd_total" ? "$M" : unit === "usd" ? "$" : "";
  return (
    <div className="flex flex-wrap items-center gap-1.5 py-1.5 text-[10.5px]">
      <input value={value} onChange={(e) => setValue(e.target.value)} placeholder={`value ${hint}`} className="w-20 rounded bg-zinc-900 border border-[#d4af37]/20 px-1 py-0.5" />
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (required)" className="flex-1 min-w-[10rem] rounded bg-zinc-900 border border-[#d4af37]/20 px-1 py-0.5" />
      <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="source, e.g. Q2 call" className="w-28 rounded bg-zinc-900 border border-[#d4af37]/20 px-1 py-0.5" />
      <button type="button" disabled={!value || reason.trim().length < 5 || m.isPending} onClick={() => m.mutate("proposed")}
        className="rounded border border-amber-400/40 px-1.5 py-0.5 text-amber-200 disabled:opacity-40">Propose</button>
      <button type="button" disabled={!value || reason.trim().length < 5 || m.isPending} onClick={() => m.mutate("active")}
        className="rounded bg-[#d4af37]/80 px-1.5 py-0.5 text-black disabled:opacity-40">Apply</button>
      {m.error && <span className="text-red-300">{String((m.error as Error).message)}</span>}
      <span className="w-full text-[9.5px] text-amber-200/40">Expires at the next earnings report by default. Base fair value is unchanged; this adds an Adjusted value.</span>
    </div>
  );
}

function FieldHistoryRow({ ticker, input }: { ticker: string; input: Input }) {
  const { data } = useQuery({
    queryKey: ["fv-field-history", ticker, input.field],
    queryFn: async (): Promise<FieldHistory> => (await fetch(`/api/fair-value/${ticker}/assumptions/history?field=${input.field}`, { credentials: "include" })).json(),
  });
  if (!data) return <p className="py-1 text-[10px] text-amber-200/40">Loading…</p>;
  return (
    <div className="py-1 space-y-0.5 text-[10.5px]">
      {[...data.changes].reverse().map((c, i) => (
        <div key={i} className="flex gap-2"><span className="w-20 text-amber-200/40 tabular-nums">{c.date}</span><span className="tabular-nums">{fmtUnit(c.value, input.unit)}</span><span className="text-amber-200/30">data</span></div>
      ))}
      {data.overrides.map((o) => (
        <div key={o.id} className="flex gap-2"><span className="w-20 text-amber-200/40 tabular-nums">{o.created_at.slice(0, 10)}</span>
          <span className="tabular-nums">{fmtUnit(o.value, input.unit)}</span><span className={cn("rounded border px-1 text-[9px] uppercase", STATUS[o.status])}>{o.status}</span>
          <span className="text-amber-100/60 truncate">{o.reason}</span></div>
      ))}
      <p className="text-[9.5px] text-amber-200/30">Data history starts {data.changes[0]?.date ?? "—"} (recorded when the inputs change).</p>
    </div>
  );
}

export function AssumptionsTab({ ticker }: { ticker: string }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const { data, isLoading } = useQuery({
    queryKey: ["fv-assumptions", ticker],
    queryFn: async (): Promise<Sheet> => {
      const r = await fetch(`/api/fair-value/${encodeURIComponent(ticker)}/assumptions`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });
  const decide = useMutation({
    mutationFn: async ({ id, action }: { id: number; action: "accept" | "reject" | "retire" }) => {
      const r = await fetch(`/api/fair-value/assumptions/${id}`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fv-assumptions", ticker] }),
  });
  if (isLoading || !data) return <p className="text-[10px] text-amber-200/40">Loading…</p>;
  const L = data.latest;
  const sp = data.shared.params;
  const cohortRows = data.assumptions.filter((a) => a.scope === "peer_group" && a.status === "active");
  const unitOf = (f: string) => data.inputs.find((i) => i.field === f)?.unit ?? "x";

  return (
    <div className="space-y-2.5 text-[11px] text-amber-100/80">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span><span className="text-amber-200/50">Base fair value</span> <b className="text-amber-100">{L?.fair_value != null ? `$${L.fair_value.toFixed(2)}` : "—"}</b>
          {L?.confidence && <span className="text-amber-200/40"> ({L.confidence})</span>}</span>
        {L?.adjusted_fair_value != null && <span><span className="text-amber-200/50">Adjusted</span> <b className="text-[#d4af37]">${L.adjusted_fair_value.toFixed(2)}</b></span>}
        <span className="text-amber-200/50">price {L?.price != null ? `$${L.price.toFixed(2)}` : "—"}</span>
        {data.streetPt != null && (
          <span className="text-amber-200/50">street ${data.streetPt.toFixed(0)}
            {L?.fair_value != null && data.streetPt > 0 && (
              <span className={cn(
                "ml-1",
                ((L.fair_value - data.streetPt) / data.streetPt) >= 0 ? "text-green-400/80" : "text-red-400/80",
              )}>
                ({((L.fair_value - data.streetPt) / data.streetPt * 100) >= 0 ? "+" : ""}
                {((L.fair_value - data.streetPt) / data.streetPt * 100).toFixed(0)}% vs FV)
              </span>
            )}
          </span>
        )}
        {L?.implied_growth != null && (
          <span className="text-amber-200/50" title="Reverse DCF on today's price">
            px implies {(L.implied_growth * 100).toFixed(0)}% g
          </span>
        )}
        {data.streetImpliedGrowth != null && (
          <span className="text-sky-300/80" title="Reverse DCF on street consensus PT (same cost of equity / terminal g)">
            street implies {(data.streetImpliedGrowth * 100).toFixed(0)}% g
            {data.growthCap != null && (
              <span className="text-amber-200/40"> vs our cap {(data.growthCap * 100).toFixed(0)}%</span>
            )}
          </span>
        )}
        <span className="ml-auto text-[10px] text-amber-200/40">{L?.as_of}</span>
      </div>
      {data.furthestVoters && data.furthestVoters.length > 0 && data.streetPt != null && (
        <p className="text-[10px] text-amber-200/45">
          Voters furthest from street ${data.streetPt.toFixed(0)}:{" "}
          {data.furthestVoters.map((v, i) => (
            <span key={v.name}>
              {i > 0 ? " · " : ""}
              {v.name} ${v.value.toFixed(0)} ({v.gapPct >= 0 ? "+" : ""}{v.gapPct.toFixed(0)}%)
            </span>
          ))}
        </p>
      )}
      <FvVsStreetChart ticker={ticker} />
      {L && L.fair_value == null && (
        <p className="text-[10px] text-amber-200/50">No model value: the {data.cohort?.name ?? L.mode} cohort ({L.mode}) gets no model fair value by design (pre-revenue / speculative); the analyst target is shown separately.</p>
      )}

      <section>
        <div className="text-[10px] font-semibold text-[#d4af37]/80 mb-0.5">Shared rules — same for every stock</div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10.5px]">
          <span>model <b>{data.shared.version}</b> <span className="text-amber-200/40">since {data.shared.changedAt?.slice(0, 10) ?? "—"}</span></span>
          <span>ERP {pct(sp.equityRiskPremium)}</span><span>terminal g {pct(sp.terminalGrowth)}</span>
          <span>growth {pct(sp.growthFloor)}–{pct(sp.growthCap)}</span><span>cost of equity {range(sp.costOfEquityClamp, (x) => `${(x * 100).toFixed(0)}%`)}</span>
          <span>beta {range(sp.betaClamp, (x) => x.toFixed(1))}</span><span>analyst-target haircut {pct(sp.analystBias)}</span>
        </div>
        <div className="mt-0.5 text-[10.5px]">
          <span className="text-amber-200/50">Cohort:</span> {data.cohort ? `${data.cohort.name} · ${data.cohort.scoring_mode} · ${data.cohort.members} members (peer medians)` : "none (standard)"}
          {cohortRows.map((a) => (
            <span key={a.id} className="ml-2 rounded border border-amber-400/40 px-1 text-amber-300" title={a.reason}>{COHORT_LABEL[a.field] ?? a.field} {pct(a.value)} (cohort override)</span>
          ))}
        </div>
      </section>

      <section>
        <div className="text-[10px] font-semibold text-[#d4af37]/80 mb-0.5">This stock's inputs <span className="font-normal text-amber-200/40">(data; history since {data.inputsSince ?? "—"})</span></div>
        <table className="w-full text-[10.5px]">
          <thead><tr className="text-amber-200/40 text-left"><th className="font-normal">Input</th><th className="font-normal">Value</th><th className="font-normal">Last changed</th><th /></tr></thead>
          <tbody>
            {data.inputs.map((i) => {
              const ov = data.assumptions.find((a) => a.scope === "ticker" && a.field === i.field && a.status === "active");
              return (
                <Fragment key={i.field}>
                  <tr className="border-t border-[#d4af37]/10">
                    <td className="py-0.5 pr-2" title={i.source}>{i.label}</td>
                    <td className="pr-2 tabular-nums">
                      <span className={cn(ov && "line-through text-amber-200/40")}>{fmtUnit(i.value, i.unit)}</span>
                      {ov && <span className="ml-1 text-[#d4af37]" title={ov.reason}>{fmtUnit(ov.value, i.unit)}</span>}
                    </td>
                    <td className="pr-2 text-amber-200/40 tabular-nums">{i.lastChanged ?? "—"}</td>
                    <td className="text-right whitespace-nowrap">
                      <button type="button" title="History" onClick={() => setOpen(open === i.field ? null : i.field)} className="p-0.5 text-amber-200/50 hover:text-[#d4af37]"><History className="h-3 w-3" /></button>
                      {isAdmin && i.overridable && (
                        <button type="button" title="Override (logged)" onClick={() => setEditing(editing === i.field ? null : i.field)} className="p-0.5 text-amber-200/50 hover:text-[#d4af37]"><Pencil className="h-3 w-3" /></button>
                      )}
                    </td>
                  </tr>
                  {open === i.field && <tr><td colSpan={4}><FieldHistoryRow ticker={ticker} input={i} /></td></tr>}
                  {editing === i.field && <tr><td colSpan={4}><OverrideForm ticker={ticker} field={i.field} unit={i.unit} onDone={() => setEditing(null)} /></td></tr>}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </section>

      <section>
        <div className="text-[10px] font-semibold text-[#d4af37]/80 mb-0.5">Judgement log <span className="font-normal text-amber-200/40">(never edited; a change is a new row)</span></div>
        {data.assumptions.length === 0 ? (
          <p className="text-[10px] text-amber-200/40 italic">No overrides — this stock uses the shared rules only.</p>
        ) : (
          <ul className="space-y-1">
            {data.assumptions.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-x-2 text-[10.5px]">
                <span className={cn("rounded border px-1 text-[9px] uppercase", STATUS[a.status])}>{a.status}</span>
                <span>{a.scope === "peer_group" ? `cohort ${COHORT_LABEL[a.field] ?? a.field}` : data.inputs.find((i) => i.field === a.field)?.label ?? a.field}</span>
                <b className="tabular-nums">{a.scope === "peer_group" ? pct(a.value) : fmtUnit(a.value, unitOf(a.field))}</b>
                <span className="text-amber-100/60">{a.reason}</span>
                <span className="text-amber-200/40">{a.source} · {a.created_at.slice(0, 10)}{a.expires_at ? ` · expires ${a.expires_at.slice(0, 10)}` : ""}</span>
                {isAdmin && a.status === "proposed" && (<>
                  <button type="button" onClick={() => decide.mutate({ id: a.id, action: "accept" })} className="text-emerald-300 hover:underline">accept</button>
                  <button type="button" onClick={() => decide.mutate({ id: a.id, action: "reject" })} className="text-red-300/80 hover:underline">reject</button>
                </>)}
                {isAdmin && a.status === "active" && (
                  <button type="button" onClick={() => decide.mutate({ id: a.id, action: "retire" })} className="text-amber-200/60 hover:underline">retire</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.history.filter((h) => h.fair_value != null).length >= 2 && (
        <section>
          <div className="text-[10px] font-semibold text-[#d4af37]/80 mb-0.5">Fair value vs price</div>
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data.history} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <XAxis dataKey="as_of" hide /><YAxis hide domain={["auto", "auto"]} />
                <Tooltip contentStyle={{ background: "#09090b", border: "1px solid #d4af3733", fontSize: 10 }} />
                <Line dataKey="price" stroke="#a1a1aa" strokeWidth={1} dot={false} isAnimationActive={false} />
                <Line dataKey="fair_value" name="base" stroke="#d4af37" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                <Line dataKey="adjusted_fair_value" name="adjusted" stroke="#34d399" strokeWidth={1.2} strokeDasharray="3 3" dot={false} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}
    </div>
  );
}
