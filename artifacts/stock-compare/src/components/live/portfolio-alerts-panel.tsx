/**
 * Live › Portfolio Alerts — concise book-risk bullets from scripts/watchlist_sync/pm_alerts.py (Claude, PM role).
 * Odds = market-implied (each put's IV) + the trader's own expiry clustering (S015); thresholds are defaults the user tunes.
 * Display only: no trading actions.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Bullet = { key: string; level: "red" | "amber" | "green"; text: string; change: "new" | "worse" | "better" | null };
type Run = {
  generatedAt: string;
  priced_at: string;
  prices: string;
  bullets: Bullet[];
  cleared: string[];
  accounts: Record<string, { status: "red" | "amber" | "green"; risk?: number; expiry?: string }>;
};

const DOT: Record<Bullet["level"], string> = { red: "bg-red-500", amber: "bg-amber-400", green: "bg-emerald-500" };
const CHIP: Record<Bullet["level"], string> = {
  red: "border-red-500/40 text-red-300",
  amber: "border-amber-400/40 text-amber-200",
  green: "border-emerald-500/40 text-emerald-300",
};

function ago(iso: string): string {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

type CallSummary = {
  guidance?: string; guidance_detail?: string; tone?: number; financing?: string; demand?: string; margins?: string;
  risks?: string[]; catalysts?: string[]; bullets?: string[];
};
type Name = {
  ticker: string; held_shares: boolean; short_options: number; short_pct: number | null; next_earnings: string | null;
  quarter: string | null; summary: CallSummary | null;
};

const GUIDE: Record<string, string> = {
  raised: "text-emerald-300 border-emerald-500/40", initiated: "text-emerald-300/80 border-emerald-500/30",
  maintained: "text-amber-200/70 border-amber-200/20", none: "text-amber-200/40 border-amber-200/10",
  lowered: "text-red-300 border-red-500/40", withdrawn: "text-red-300 border-red-500/40",
};

function daysTo(d: string): number {
  return Math.round((new Date(d + "T12:00:00").getTime() - Date.now()) / 86_400_000);
}

function NameRow({ n }: { n: Name }) {
  const [open, setOpen] = useState(false);
  const s = n.summary;
  const si = n.short_pct;
  const ed = n.next_earnings ? daysTo(n.next_earnings) : null;
  return (
    <li className="border-t border-[#d4af37]/10 first:border-t-0">
      <button type="button" onClick={() => s && setOpen(!open)} className="w-full text-left py-1.5 flex items-center gap-2 text-[12px]">
        <span className="w-12 font-semibold text-amber-100">{n.ticker}</span>
        <span className="w-14 text-[10px] text-amber-200/50">{n.short_options > 0 ? `${n.short_options} put${n.short_options > 1 ? "s" : ""}` : "shares"}</span>
        <span
          className={cn("w-16 tabular-nums text-[11px]", si == null ? "text-amber-200/30" : si >= 30 ? "text-red-300" : si >= 15 ? "text-amber-300" : "text-amber-200/60")}
          title="Short interest, % of free float (LSEG, daily)"
        >
          {si == null ? "SI —" : `SI ${si.toFixed(0)}%`}
        </span>
        <span className={cn("w-16 tabular-nums text-[11px]", ed != null && ed <= 7 ? "text-amber-300" : "text-amber-200/50")} title="Next earnings">
          {ed == null ? "ER —" : ed === 0 ? "ER today" : `ER ${ed}d`}
        </span>
        {s ? (
          <span className="flex-1 min-w-0 flex items-center gap-1.5">
            <span className={cn("shrink-0 rounded border px-1 text-[9px] uppercase", GUIDE[s.guidance ?? "none"] ?? GUIDE.none)}>{s.guidance ?? "—"}</span>
            <span className="truncate text-amber-100/70">{s.bullets?.[0]}</span>
          </span>
        ) : (
          <span className="flex-1 text-[10px] text-amber-200/30">call summary pending</span>
        )}
      </button>
      {open && s && (
        <div className="pb-2 pl-14 space-y-1 text-[11px] text-amber-100/75">
          <div className="text-[10px] text-amber-200/40">{n.quarter} call · guidance: {s.guidance_detail || s.guidance}</div>
          <ul className="list-disc pl-4 space-y-0.5">{s.bullets?.map((b, i) => <li key={i}>{b}</li>)}</ul>
          {s.financing && <div><span className="text-amber-200/50">Financing / dilution:</span> {s.financing}</div>}
          {!!s.risks?.length && <div><span className="text-amber-200/50">Risks:</span> {s.risks.join(" · ")}</div>}
          {!!s.catalysts?.length && <div><span className="text-amber-200/50">Catalysts:</span> {s.catalysts.join(" · ")}</div>}
        </div>
      )}
    </li>
  );
}

function YourNames() {
  const { data } = useQuery({
    queryKey: ["pm-names"],
    queryFn: async (): Promise<Name[]> => {
      const r = await fetch("/api/pm/names", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).names;
    },
    staleTime: 10 * 60_000,
  });
  if (!data?.length) return null;
  return (
    <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-3">
      <div className="text-[11px] font-semibold text-[#d4af37] mb-1">Your names</div>
      <ul>{data.map((n) => <NameRow key={n.ticker} n={n} />)}</ul>
      <p className="mt-1 text-[10px] text-amber-200/30">
        SI = short interest % of float (context, not a signal yet). Tap a row for the last earnings call: 5 points, financing, risks.
      </p>
    </div>
  );
}

type Finding = { study: string; title: string; verdict: "running" | "pass" | "fail" | "not_enough"; headline: string;
  card: Record<string, string> | null; updatedAt: string };
const VERDICT: Record<Finding["verdict"], [string, string]> = {
  pass: ["bg-emerald-500", "rule"], fail: ["bg-zinc-500", "no edge"], not_enough: ["bg-amber-400", "too little data"], running: ["bg-sky-500/70", "running"],
};

/** Study verdicts on your own trades (S017–S021, optlab.findings). Card details sit in the ⓘ tooltip (user rule: point first). */
function Playbook() {
  const { data } = useQuery({
    queryKey: ["pm-playbook"],
    queryFn: async (): Promise<Finding[]> => {
      const r = await fetch("/api/pm/playbook", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).findings;
    },
    staleTime: 30 * 60_000,
  });
  if (!data?.length) return null;
  return (
    <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-3">
      <div className="text-[11px] font-semibold text-[#d4af37] mb-1">Playbook · tested on your trades</div>
      <ul className="space-y-0.5">
        {data.map((f) => (
          <li key={f.study} className="flex items-center gap-2 text-[11px]">
            <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", VERDICT[f.verdict]?.[0] ?? "bg-zinc-500")} />
            <span className="text-amber-100">{f.title}</span>
            <span className="text-amber-200/50 truncate">{f.verdict === "running" ? VERDICT.running[1] : f.headline}</span>
            <Tooltip delayDuration={150}>
              <TooltipTrigger asChild>
                <button type="button" className="ml-auto text-amber-200/40 hover:text-amber-200/80"><Info className="w-3 h-3" /></button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[320px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
                <div className="font-semibold">{f.study} · {VERDICT[f.verdict]?.[1]}</div>
                <div>{f.headline}</div>
                {f.card && Object.entries(f.card).map(([k, v]) => <div key={k}><span className="text-amber-200/60">{k}:</span> {v}</div>)}
              </TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function PortfolioAlertsPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["pm-alerts"],
    queryFn: async (): Promise<Run | null> => {
      const r = await fetch("/api/pm/alerts", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).run;
    },
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) return <div className="text-[11px] text-amber-200/40 p-3">Loading…</div>;
  if (error) return <div className="text-[11px] text-red-300/80 p-3">Portfolio Alerts unavailable ({String((error as Error).message)}).</div>;
  if (!data) return <div className="text-[11px] text-amber-200/50 p-3">Not run yet — the PM job writes here every 15 min in market hours.</div>;

  return (
    <div className="space-y-3">
      <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {Object.entries(data.accounts).map(([name, a]) => (
            <span key={name} className={cn("rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase", CHIP[a.status])}>
              {name} {a.status}
            </span>
          ))}
          <span className="ml-auto text-[10px] text-amber-200/40 tabular-nums" title={`Checked ${data.generatedAt}`}>
            {data.prices} · {ago(data.priced_at)}
          </span>
        </div>
        {data.bullets.length === 0 ? (
          <p className="text-[12px] text-emerald-300/80">All clear — no account crosses a risk line.</p>
        ) : (
          <ul className="space-y-1.5">
            {data.bullets.map((b) => (
              <li key={b.key} className="flex gap-2 text-[12px] leading-snug text-amber-100/85">
                <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", DOT[b.level])} />
                <span>
                  {b.text}
                  {b.change && (
                    <span className={cn("ml-1.5 text-[10px] font-semibold uppercase", b.change === "better" ? "text-emerald-400" : "text-red-400")}>
                      {b.change}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {data.cleared.length > 0 && (
          <p className="text-[10px] text-emerald-400/70">Cleared since last check: {data.cleared.join(", ")}</p>
        )}
        <p className="text-[10px] text-amber-200/30">
          Odds come from each option's own price (market-implied, not a forecast), with your past expiries' tendency to breach together.
          You decide; closing is shown only as what it would change.
        </p>
      </div>
      <YourNames />
      <Playbook />
    </div>
  );
}
