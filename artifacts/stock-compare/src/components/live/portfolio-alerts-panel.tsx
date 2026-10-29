/**
 * Live › Portfolio Alerts — concise book-risk bullets from scripts/watchlist_sync/pm_alerts.py (Claude, PM role).
 * Odds = market-implied (each put's IV) + the trader's own expiry clustering (S015); thresholds are defaults the user tunes.
 * Display only: no trading actions.
 */
import { useState, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { HouseViewCard } from "@/components/live/house-view-card";
import { optionsScannerHref } from "@/lib/ticker-shelf-storage";

type Bullet = { key: string; level: "red" | "amber" | "green"; text: string; change: "new" | "worse" | "better" | null };
type Run = {
  generatedAt: string;
  priced_at: string;
  prices: string;
  bullets: Bullet[];
  cleared: string[];
  accounts: Record<string, { status: "red" | "amber" | "green"; risk?: number; expiry?: string }>;
  credit?: { on: boolean; spread: number; p80: number; as_of: string } | null; // S028 context, display only
  gamma?: { negative: boolean; gex_bn: number; pct_1y: number; since: string; as_of: string; stale: boolean } | null; // A134, display only
  bets?: { n_puts: number; effective: number; ms: number } | null; // A117 PCA effective bets, display only
  model?: { rho?: number; corr?: string; corr_ms?: number; paths?: number } | null; // A117 corr mode
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
      <div className="py-1.5 flex items-center gap-2 text-[12px]">
        <Link
          href={optionsScannerHref(n.ticker)}
          className="w-12 font-semibold text-[#d4af37] hover:underline shrink-0"
          title="Open Options for this name"
        >
          {n.ticker}
        </Link>
      <button type="button" onClick={() => s && setOpen(!open)} className="flex-1 min-w-0 text-left flex items-center gap-2">
        <span className="w-14 text-[10px] text-amber-200/50">{n.short_options > 0 ? `${n.short_options} put${n.short_options > 1 ? "s" : ""}` : "shares"}</span>
        <span
          className={cn("w-16 tabular-nums text-[11px]", si == null ? "text-amber-100" : si >= 30 ? "text-red-300" : si >= 15 ? "text-amber-300" : "text-amber-200/60")}
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
          <span className="flex-1 text-[10px] text-amber-100">call summary pending</span>
        )}
      </button>
      </div>
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
      <p className="mt-1 text-[10px] text-amber-100">
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
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["pm-alerts"],
    queryFn: async (): Promise<Run | null> => {
      const r = await fetch("/api/pm/alerts", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).run;
    },
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
  });
  // Ex-div bullets fill in background on first miss — one quick refetch picks them up.
  useEffect(() => {
    const t = window.setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ["pm-alerts"] });
    }, 2500);
    return () => window.clearTimeout(t);
  }, [qc]);

  if (isLoading) return <div className="text-[11px] text-amber-200/40 p-3">Loading…</div>;
  if (error) return <div className="text-[11px] text-red-300/80 p-3">Portfolio Alerts unavailable ({String((error as Error).message)}).</div>;
  if (!data) return <div className="text-[11px] text-amber-200/50 p-3">Not run yet — the PM job writes here every 15 min in market hours.</div>;

  return (
    <div className="space-y-3">
      <HouseViewCard />
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
        {data.gamma && (
          <div className={cn("flex items-center gap-1.5 text-[12px] leading-snug", data.gamma.negative && !data.gamma.stale ? "text-amber-200/90" : "text-white/45")}>
            <span>
              Dealer gamma: {data.gamma.negative ? "negative" : "positive"} since {data.gamma.since.slice(5)} ({data.gamma.gex_bn < 0 ? "−" : ""}${Math.abs(data.gamma.gex_bn).toFixed(1)}bn, {data.gamma.pct_1y}th pct 1y)
              {data.gamma.stale && <> · stale, as of {data.gamma.as_of.slice(5)}</>}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="text-amber-200/40 hover:text-amber-200/80"><Info className="w-3 h-3" /></button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[320px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
                <div>SqueezeMetrics SPX gamma exposure (GEX), as of {data.gamma.as_of}. Assumes dealers are long calls, short puts.</div>
                <div className="mt-1">Negative = dealer hedging amplifies moves. Probe 10-16 (2011–26): weeks after negative GEX had SPX 5-day drops &gt;3% 12.7% of the time vs 5.8%, partly because implied vol is already high then.</div>
                <div className="mt-1 text-amber-200/60">Display only — study S034 pending; not in any score.</div>
              </TooltipContent>
            </Tooltip>
          </div>
        )}
        {data.bets && data.bets.n_puts >= 2 && (
          <div className="flex items-center gap-1.5 text-[12px] leading-snug text-white/45">
            <span>
              Effective bets: {data.bets.n_puts} short puts ≈ {data.bets.effective} independent
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="text-amber-200/40 hover:text-amber-200/80"><Info className="w-3 h-3" /></button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[320px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
                <div>PCA on 60-day daily returns of short-put underlyings (corr shrunk 30% to identity). (Σλ)²/Σλ² ≈ how many independent bets the book is.</div>
                <div className="mt-1 text-amber-200/60">Display only (A117) · {data.bets.ms} ms · not in any score.</div>
              </TooltipContent>
            </Tooltip>
          </div>
        )}
        {data.model?.corr && (
          <div className="flex items-center gap-1.5 text-[11px] leading-snug text-white/35">
            <span>
              MC corr: {data.model.corr === "cholesky" ? "empirical Cholesky" : data.model.corr === "mixed" ? "Cholesky + one-factor mix" : `one-factor ρ=${data.model.rho ?? 0.6}`}
              {data.model.corr_ms != null ? ` · ${data.model.corr_ms} ms` : ""}
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" className="text-amber-200/40 hover:text-amber-200/80"><Info className="w-3 h-3" /></button>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[320px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
                <div>Joint move model for the 20k-path book MC. Empirical = 60d shrunk corr → Cholesky; falls back to S015 one-factor ρ=0.6 when history is thin.</div>
                <div className="mt-1 text-amber-200/60">A117 · not a new score — same thresholds as before.</div>
              </TooltipContent>
            </Tooltip>
          </div>
        )}
        {data.credit?.on && (
          <p className="text-[12px] leading-snug text-amber-200/90" title={`Baa−10y ${data.credit.spread.toFixed(2)}% vs 1-y 80th pct ${data.credit.p80.toFixed(2)}% (${data.credit.as_of})`}>
            Credit spreads wide: S&amp;P fell ≥5% within a month 25% of the time in past cases (vs 13%) — your puts weren't hurt more (S028)
          </p>
        )}
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
        <p className="text-[10px] text-amber-100">
          Odds come from each option's own price (market-implied, not a forecast), with your past expiries' tendency to breach together.
          You decide; closing is shown only as what it would change.
        </p>
      </div>
      <WhatIfPut />
      <YourNames />
      <Playbook />
    </div>
  );
}

/** A136 — what-if add this put (same MC engine as alerts). Advisory badge only. */
function WhatIfPut() {
  const [account, setAccount] = useState("FILDI");
  const [ticker, setTicker] = useState("");
  const [strike, setStrike] = useState("");
  const [expiry, setExpiry] = useState("");
  const [qty, setQty] = useState("1");
  const [iv, setIv] = useState("");
  const [spot, setSpot] = useState("");
  const [premium, setPremium] = useState("");
  const mut = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/pm/what-if", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account, ticker, strike: Number(strike), expiry, qty: Number(qty),
          iv: Number(iv) > 1 ? Number(iv) / 100 : Number(iv),
          spot: Number(spot),
          premium: premium ? Number(premium) : null,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json() as Promise<{
        badge: string; reasons: string[]; risk_base: number | null; risk_with: number | null;
        crash_base: number | null; crash_with: number | null; note?: string; error?: string;
      }>;
    },
  });
  const badgeCls =
    mut.data?.badge === "red" ? "border-red-400/50 text-red-200 bg-red-500/15" :
    mut.data?.badge === "amber" ? "border-amber-400/50 text-amber-200 bg-amber-500/15" :
    "border-emerald-400/50 text-emerald-200 bg-emerald-500/15";
  return (
    <div className="rounded border border-[#d4af37]/20 bg-zinc-950 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-[11px] font-bold uppercase tracking-wider text-[#d4af37]">What-if add put</h3>
        <span className="text-[10px] text-amber-200/40">A136 · same engine as alerts · you decide</span>
      </div>
      <div className="flex flex-wrap gap-1.5 items-end">
        <select value={account} onChange={(e) => setAccount(e.target.value)} className="bg-black border border-zinc-700 rounded px-1.5 py-1 text-[11px]">
          <option value="FILDI">FILDI</option>
          <option value="IRA">IRA</option>
        </select>
        <input placeholder="Ticker" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())}
          className="w-16 bg-black border border-zinc-700 rounded px-1.5 py-1 text-[11px] font-mono" />
        <input placeholder="Strike" value={strike} onChange={(e) => setStrike(e.target.value)}
          className="w-16 bg-black border border-zinc-700 rounded px-1.5 py-1 text-[11px] font-mono" />
        <input placeholder="YYYY-MM-DD" value={expiry} onChange={(e) => setExpiry(e.target.value)}
          className="w-28 bg-black border border-zinc-700 rounded px-1.5 py-1 text-[11px] font-mono" />
        <input placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)}
          className="w-12 bg-black border border-zinc-700 rounded px-1.5 py-1 text-[11px] font-mono" />
        <input placeholder="IV (0.35 or 35)" value={iv} onChange={(e) => setIv(e.target.value)}
          className="w-24 bg-black border border-zinc-700 rounded px-1.5 py-1 text-[11px] font-mono" />
        <input placeholder="Spot" value={spot} onChange={(e) => setSpot(e.target.value)}
          className="w-16 bg-black border border-zinc-700 rounded px-1.5 py-1 text-[11px] font-mono" />
        <input placeholder="Prem $" value={premium} onChange={(e) => setPremium(e.target.value)}
          className="w-16 bg-black border border-zinc-700 rounded px-1.5 py-1 text-[11px] font-mono" />
        <button
          type="button"
          disabled={mut.isPending || !ticker || !strike || !expiry || !iv || !spot}
          onClick={() => mut.mutate()}
          className="text-[11px] px-2 py-1 rounded border border-[#d4af37]/50 bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {mut.isPending ? "Running…" : "Run"}
        </button>
      </div>
      {mut.error && <p className="text-[11px] text-red-300">{(mut.error as Error).message}</p>}
      {mut.data && !mut.data.error && (
        <div className={cn("rounded border px-2 py-1.5 text-[11px] space-y-0.5", badgeCls)}>
          <div className="font-bold uppercase tracking-wide">{mut.data.badge}</div>
          {(mut.data.reasons ?? []).map((r, i) => <div key={i}>{r}</div>)}
          <div className="text-[10px] opacity-70">{mut.data.note}</div>
        </div>
      )}
      {mut.data?.error && <p className="text-[11px] text-red-300">{mut.data.error}</p>}
    </div>
  );
}
