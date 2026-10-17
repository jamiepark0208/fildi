/**
 * A136 — on-demand book-risk badge (same MC as Portfolio Alerts › What-if).
 * Advisory only; Override logs to watchlist_sync.pm_risk_overrides.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { cn } from "@/lib/utils";

export type WhatIfResult = {
  badge: string;
  reasons: string[];
  risk_base: number | null;
  risk_with: number | null;
  crash_base: number | null;
  crash_with: number | null;
  note?: string;
  error?: string;
};

export type RiskWhatIfInput = {
  account: "IRA" | "FILDI";
  ticker: string;
  strike: number;
  expiry: string;
  qty?: number;
  iv: number;
  spot: number;
  premium?: number | null;
  /** Surface label for override log (model_list | scanner | desk). */
  surface?: string;
};

function badgeCls(badge: string | undefined) {
  if (badge === "red") return "border-red-400/50 text-red-200 bg-red-500/15";
  if (badge === "amber") return "border-amber-400/50 text-amber-200 bg-amber-500/15";
  return "border-emerald-400/50 text-emerald-200 bg-emerald-500/15";
}

export function RiskWhatIfBadge({
  input,
  compact = false,
  className,
}: {
  input: RiskWhatIfInput | null;
  compact?: boolean;
  className?: string;
}) {
  const [note, setNote] = useState("");
  const run = useMutation({
    mutationFn: async (): Promise<WhatIfResult> => {
      if (!input) throw new Error("missing contract");
      const iv = input.iv > 1.5 ? input.iv / 100 : input.iv;
      const r = await fetch("/api/pm/what-if", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: input.account,
          ticker: input.ticker,
          strike: input.strike,
          expiry: input.expiry,
          qty: input.qty ?? 1,
          iv,
          spot: input.spot,
          premium: input.premium ?? null,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
  });
  const override = useMutation({
    mutationFn: async () => {
      if (!input || !run.data) throw new Error("run first");
      const r = await fetch("/api/pm/risk-override", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: input.account,
          ticker: input.ticker,
          strike: input.strike,
          expiry: input.expiry,
          qty: input.qty ?? 1,
          badge: run.data.badge,
          reasons: run.data.reasons ?? [],
          note: note.trim() || null,
          surface: input.surface ?? "ui",
          risk_base: run.data.risk_base,
          risk_with: run.data.risk_with,
          crash_base: run.data.crash_base,
          crash_with: run.data.crash_with,
        }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return r.json();
    },
  });

  if (!input) return null;
  const ready = input.strike > 0 && input.iv > 0 && input.spot > 0 && /^\d{4}-\d{2}-\d{2}$/.test(input.expiry);

  return (
    <div className={cn("rounded border border-[#d4af37]/20 bg-zinc-950/80 p-2 space-y-1.5", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-bold uppercase tracking-wider text-[#d4af37]">
          Book risk
        </span>
        <span className="text-[9px] text-amber-200/40">A136 · on demand · you decide</span>
        <button
          type="button"
          disabled={!ready || run.isPending}
          onClick={() => run.mutate()}
          className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-[#d4af37]/20 text-[#d4af37] hover:bg-[#d4af37]/30 disabled:opacity-40"
        >
          {run.isPending ? "…" : run.data ? "Re-run" : "Check"}
        </button>
      </div>
      {!compact && (
        <div className="text-[10px] font-mono text-zinc-500">
          {input.account} {input.ticker} {input.strike}P {input.expiry}
          {input.qty && input.qty > 1 ? ` ×${input.qty}` : ""}
        </div>
      )}
      {run.error && <p className="text-[10px] text-red-300">{(run.error as Error).message}</p>}
      {run.data?.error && <p className="text-[10px] text-red-300">{run.data.error}</p>}
      {run.data && !run.data.error && (
        <div className={cn("rounded border px-1.5 py-1 text-[10px] space-y-0.5", badgeCls(run.data.badge))}>
          <div className="font-bold uppercase tracking-wide">{run.data.badge}</div>
          {(run.data.reasons ?? []).slice(0, 4).map((r, i) => (
            <div key={i}>{r}</div>
          ))}
          {run.data.note && <div className="opacity-70">{run.data.note}</div>}
          {(run.data.badge === "red" || run.data.badge === "amber") && (
            <div className="flex flex-wrap items-center gap-1 pt-1 border-t border-white/10 mt-1">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why override?"
                className="flex-1 min-w-[8rem] bg-black/40 border border-zinc-700 rounded px-1 py-0.5 text-[10px]"
              />
              <button
                type="button"
                disabled={override.isPending || override.isSuccess}
                onClick={() => override.mutate()}
                className="text-[10px] px-1.5 py-0.5 rounded border border-white/20 hover:bg-white/10 disabled:opacity-50"
              >
                {override.isSuccess ? "Logged" : override.isPending ? "…" : "Override · log"}
              </button>
            </div>
          )}
          {override.error && <p className="text-red-300">{(override.error as Error).message}</p>}
        </div>
      )}
    </div>
  );
}

/** Map Model List account strings → what-if account. */
export function modelAccountToPm(account: string | null | undefined): "IRA" | "FILDI" {
  const a = (account ?? "").toUpperCase();
  if (a.includes("IRA")) return "IRA";
  return "FILDI";
}
