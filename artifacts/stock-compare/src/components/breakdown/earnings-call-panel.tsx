/**
 * Breakdown › Earnings call — what analysts take from a call: guidance (numbers, vs prior, vs Street now), model inputs for the
 * FCF / fair-value view, KPIs, tone (prepared vs Q&A, quarter over quarter), what analysts pushed on, financing/dilution.
 * Source: AV transcripts summarized by Haiku (scripts/watchlist_sync/transcripts.py). Data: GET /api/stocks/:ticker/earnings-call.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

type GuideItem = { metric: string; label: string; period: string; low: number | null; high: number | null; unit: string; prior_low: number | null; prior_high: number | null };
type Summary = {
  guidance?: string; guidance_detail?: string; guidance_items?: GuideItem[];
  model_inputs?: { revenue_growth_pct: number | null; gross_margin_pct: number | null; op_margin_pct: number | null; capex_usd_m: number | null; fcf_usd_m: number | null; period: string | null; note?: string };
  kpis?: { name: string; value: string; change: string }[];
  tone_prepared?: number; tone_qa?: number; tone?: number; analyst_concerns?: string[];
  financing?: string; demand?: string; margins?: string; risks?: string[]; catalysts?: string[]; bullets?: string[];
};
type Call = { quarter: string; summary: Summary; av_sentiment: number | null };
type Street = { revenue_mean_fy1: number | null; eps_mean_fy1: number | null; fy1_period: string | null; eps_mean_fq1: number | null; as_of: string } | null;

const GUIDE: Record<string, string> = {
  raised: "text-emerald-300 border-emerald-500/40", initiated: "text-emerald-300/80 border-emerald-500/30",
  maintained: "text-amber-200/70 border-amber-200/20", none: "text-amber-200/40 border-amber-200/10",
  lowered: "text-red-300 border-red-500/40", withdrawn: "text-red-300 border-red-500/40",
};

function fmt(v: number | null, unit: string): string {
  if (v == null) return "—";
  if (unit === "usd_m") return v >= 1000 ? `$${(v / 1000).toFixed(2)}B` : `$${v.toFixed(0)}M`;
  if (unit === "usd_per_share") return `$${v.toFixed(2)}`;
  if (unit === "pct") return `${v}%`;
  return String(v);
}

function range(lo: number | null, hi: number | null, unit: string): string {
  if (lo == null && hi == null) return "—";
  if (hi == null || lo === hi) return `${lo != null && hi == null ? "≥ " : ""}${fmt(lo ?? hi, unit)}`;
  return `${fmt(lo, unit)}–${fmt(hi, unit)}`;
}

/** Street (LSEG consensus today) vs the guide midpoint, only where periods line up (FY1 revenue / EPS). */
function vsStreet(g: GuideItem, street: Street): string | null {
  if (!street || g.period !== street.fy1_period) return null;
  const mid = g.low != null && g.high != null ? (g.low + g.high) / 2 : g.low ?? g.high;
  if (mid == null || mid === 0) return null;
  const s = g.metric === "revenue" && g.unit === "usd_m" && street.revenue_mean_fy1 ? street.revenue_mean_fy1 / 1e6
    : g.metric === "eps" && street.eps_mean_fy1 != null ? street.eps_mean_fy1 : null;
  if (s == null) return null;
  const d = (s / mid - 1) * 100;
  return `Street ${d >= 0 ? "+" : ""}${d.toFixed(1)}% vs mid`;
}

function Tone({ v, label }: { v?: number; label: string }) {
  if (v == null) return null;
  return (
    <span className="inline-flex items-center gap-1" title={`${label} tone, −2..+2`}>
      <span className="text-amber-200/40">{label}</span>
      <span className={cn("tabular-nums", v > 0 ? "text-emerald-300" : v < 0 ? "text-red-300" : "text-amber-200/70")}>{v > 0 ? `+${v}` : v}</span>
    </span>
  );
}

function useCalls(ticker: string) {
  return useQuery({
    queryKey: ["earnings-call", ticker],
    queryFn: async (): Promise<{ calls: Call[]; street: Street }> => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/earnings-call`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 60 * 60_000,
  });
}

const EMPTY = <p className="text-[11px] text-white">No call summary yet.</p>;

function CallView({ c, prior, street, full }: { c: Call; prior: Call[]; street: Street; full: boolean }) {
  const [more, setMore] = useState(full);
  const s = c.summary;
  const items = (s.guidance_items ?? []).filter((g) => full || g.metric !== "other").slice(0, more ? 20 : 4);
  const mi = s.model_inputs;
  const miParts = mi ? [
    mi.revenue_growth_pct != null && `rev growth ${mi.revenue_growth_pct}%`, mi.gross_margin_pct != null && `GM ${mi.gross_margin_pct}%`,
    mi.op_margin_pct != null && `op margin ${mi.op_margin_pct}%`, mi.capex_usd_m != null && `capex ${fmt(mi.capex_usd_m, "usd_m")}`,
    mi.fcf_usd_m != null && `FCF ${fmt(mi.fcf_usd_m, "usd_m")}`,
  ].filter(Boolean) as string[] : [];

  return (
    <div className="space-y-1.5 text-[11px] text-amber-100/80">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-amber-200/50">{c.quarter}</span>
        <span className={cn("rounded border px-1 text-[9px] uppercase", GUIDE[s.guidance ?? "none"] ?? GUIDE.none)}>guide {s.guidance ?? "—"}</span>
        <Tone v={s.tone_prepared ?? s.tone} label="script" />
        <Tone v={s.tone_qa} label="Q&A" />
        {prior.length > 0 && (
          <span className="text-[10px] text-amber-200/40" title="Prepared-remarks tone, older → newer">
            trend {[...prior].reverse().map((p) => p.summary.tone_prepared ?? p.summary.tone ?? "·").join(" → ")} → {s.tone_prepared ?? s.tone ?? "·"}
          </span>
        )}
      </div>
      {s.guidance_detail && full && <div className="text-amber-200/60">{s.guidance_detail}</div>}

      {items.length > 0 && (
        <table className="w-full text-[10.5px]">
          <tbody>
            {items.map((g, i) => {
              const vs = vsStreet(g, street);
              const moved = g.prior_low != null || g.prior_high != null;
              return (
                <tr key={i} className="border-t border-[#d4af37]/10">
                  <td className="py-0.5 pr-1 text-amber-200/60 truncate max-w-[12rem]">{g.label}</td>
                  <td className="pr-1 text-amber-200/40">{g.period}</td>
                  <td className="pr-1 tabular-nums">{range(g.low, g.high, g.unit)}</td>
                  <td className="text-[10px] text-amber-200/40">{moved && <>was {range(g.prior_low, g.prior_high, g.unit)} </>}{vs}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {miParts.length > 0 ? (
        <div><span className="text-amber-200/50">Model inputs ({mi?.period ?? "next FY"}):</span> {miParts.join(" · ")}</div>
      ) : mi?.note ? (
        <div className="text-amber-200/50">{mi.note}</div>
      ) : null}

      {!!s.kpis?.length && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          {s.kpis.map((k, i) => (
            <span key={i}><span className="text-amber-200/50">{k.name}</span> {k.value}{k.change ? <span className="text-amber-200/40"> ({k.change})</span> : null}</span>
          ))}
        </div>
      )}

      <ul className="list-disc pl-4 space-y-0.5">{(s.bullets ?? []).slice(0, more ? 5 : 3).map((b, i) => <li key={i}>{b}</li>)}</ul>

      {more && (
        <div className="space-y-0.5">
          {s.demand && <div><span className="text-amber-200/50">Demand:</span> {s.demand}</div>}
          {s.margins && <div><span className="text-amber-200/50">Margins:</span> {s.margins}</div>}
          {!!s.analyst_concerns?.length && <div><span className="text-amber-200/50">Analysts pushed on:</span> {s.analyst_concerns.join(" · ")}</div>}
          {s.financing && <div><span className="text-amber-200/50">Financing / dilution:</span> {s.financing}</div>}
          {!!s.risks?.length && <div><span className="text-amber-200/50">Risks:</span> {s.risks.join(" · ")}</div>}
          {!!s.catalysts?.length && <div><span className="text-amber-200/50">Catalysts:</span> {s.catalysts.join(" · ")}</div>}
        </div>
      )}
      {!full && (
        <button type="button" onClick={() => setMore(!more)} className="text-[10px] text-[#d4af37]/70 hover:text-[#d4af37]">
          {more ? "Less" : "More: all guidance, analyst pushback, financing, risks"}
        </button>
      )}
    </div>
  );
}

/** Compact: latest call only (Breakdown grid panel). */
export function EarningsCallPanel({ ticker }: { ticker: string }) {
  const { data, isLoading } = useCalls(ticker);
  if (isLoading) return <p className="text-[10px] text-amber-200/40">Loading…</p>;
  const calls = data?.calls ?? [];
  if (calls.length === 0) return EMPTY;
  return (
    <div className="space-y-1">
      <CallView c={calls[0]} prior={calls.slice(1)} street={data!.street} full={false} />
      <p className="text-[9px] text-amber-100">Latest call implications (guide + risks + Street). Full history: Earnings calls tab below.</p>
    </div>
  );
}

/** Full: every stored call + how each guided figure moved across calls (Breakdown › Earnings calls tab). */
export function EarningsCallsTab({ ticker }: { ticker: string }) {
  const { data, isLoading } = useCalls(ticker);
  const [sel, setSel] = useState(0);
  if (isLoading) return <p className="text-[10px] text-amber-200/40">Loading…</p>;
  const calls = data?.calls ?? [];
  if (calls.length === 0) return EMPTY;
  const c = calls[Math.min(sel, calls.length - 1)];
  // guidance across calls: one row per (label, period), one column per call (oldest → newest)
  const cols = [...calls].reverse();
  const keys = new Map<string, { label: string; period: string; unit: string }>();
  for (const k of cols) for (const g of k.summary.guidance_items ?? []) {
    if (g.metric === "other") continue;
    keys.set(`${g.metric}|${g.period}`, { label: g.label, period: g.period, unit: g.unit });
  }
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap gap-1">
        {calls.map((k, i) => (
          <button key={k.quarter} type="button" onClick={() => setSel(i)}
            className={cn("rounded px-1.5 py-0.5 text-[10px]", i === sel ? "bg-[#d4af37]/80 text-black" : "border border-[#d4af37]/20 text-amber-200/60 hover:text-[#d4af37]")}>
            {k.quarter}
          </button>
        ))}
      </div>
      <CallView c={c} prior={calls.slice(sel + 1)} street={data!.street} full />
      {keys.size > 0 && cols.length > 1 && (
        <section>
          <div className="text-[10px] font-semibold text-[#d4af37]/80 mb-0.5">Guidance across calls</div>
          <table className="w-full text-[10.5px]">
            <thead><tr className="text-amber-200/40 text-left"><th className="font-normal">Item</th>{cols.map((k) => <th key={k.quarter} className="font-normal">{k.quarter}</th>)}</tr></thead>
            <tbody>
              {[...keys.entries()].map(([key, m]) => (
                <tr key={key} className="border-t border-[#d4af37]/10">
                  <td className="py-0.5 pr-2 text-amber-200/60">{m.label} <span className="text-amber-200/30">{m.period}</span></td>
                  {cols.map((k) => {
                    const g = (k.summary.guidance_items ?? []).find((x) => `${x.metric}|${x.period}` === key);
                    return <td key={k.quarter} className="pr-2 tabular-nums">{g ? range(g.low, g.high, g.unit) : <span className="text-amber-200/20">·</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      <p className="text-[9px] text-amber-100">Haiku extraction from the transcript (Alpha Vantage). Your names get the last 4 calls; others the latest. Street = LSEG consensus today.</p>
    </div>
  );
}
