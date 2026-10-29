/**
 * A136 — on-demand portfolio book impact (same MC as Portfolio Alerts › What-if).
 * Advisory only; Override logs to watchlist_sync.pm_risk_overrides.
 *
 * Compact by default: one chip in the action row — not a full-width "BOOK RISK" card.
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

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
  if (badge === "red") return "border-red-400/60 text-red-200 bg-red-500/20";
  if (badge === "amber") return "border-amber-400/60 text-amber-100 bg-amber-500/20";
  return "border-emerald-400/60 text-emerald-100 bg-emerald-500/20";
}

export function RiskWhatIfBadge({
  input,
  compact = true,
  className,
}: {
  input: RiskWhatIfInput | null;
  /** Always chip-first; kept for call-site compat. */
  compact?: boolean;
  className?: string;
}) {
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
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
    onSuccess: () => setOpen(true),
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
  const label = run.isPending
    ? "…"
    : run.data && !run.data.error
      ? run.data.badge.toUpperCase()
      : "Book?";

  return (
    <div className={cn("inline-flex flex-col items-start gap-1 max-w-full", className)}>
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={!ready || run.isPending}
              onClick={(e) => {
                e.stopPropagation();
                if (run.data && !run.isPending) {
                  setOpen((o) => !o);
                  return;
                }
                run.mutate();
              }}
              className={cn(
                "text-[10px] font-bold px-2 py-0.5 rounded border transition-colors disabled:opacity-40",
                run.data && !run.data.error
                  ? badgeCls(run.data.badge)
                  : "border-[#d4af37]/50 bg-zinc-900 text-white hover:bg-zinc-800",
              )}
            >
              {label}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-xs text-[11px] leading-snug">
            <p className="font-semibold text-white">Portfolio book impact</p>
            <p className="text-white/85 mt-0.5">
              Runs the same Monte Carlo as Portfolio Alerts › What-if: if you sell this put,
              how does crash / risk change vs your current book. On demand — you decide (A136).
            </p>
            {!compact && (
              <p className="font-mono text-amber-100 mt-1">
                {input.account} {input.ticker} {input.strike}P {input.expiry}
                {input.qty && input.qty > 1 ? ` ×${input.qty}` : ""}
              </p>
            )}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {run.error && <p className="text-[10px] text-red-300">{(run.error as Error).message}</p>}
      {open && run.data?.error && <p className="text-[10px] text-red-300">{run.data.error}</p>}
      {open && run.data && !run.data.error && (
        <div className={cn("rounded border px-1.5 py-1 text-[10px] space-y-0.5 w-full max-w-md", badgeCls(run.data.badge))}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-bold uppercase tracking-wide">{run.data.badge}</span>
            <button
              type="button"
              className="text-amber-100 hover:text-white text-[9px]"
              onClick={(e) => { e.stopPropagation(); run.mutate(); }}
            >
              Re-run
            </button>
          </div>
          {(run.data.reasons ?? []).slice(0, 4).map((r, i) => (
            <div key={i} className="text-white/90">{r}</div>
          ))}
          {run.data.note && <div className="text-amber-100">{run.data.note}</div>}
          {(run.data.badge === "red" || run.data.badge === "amber") && (
            <div className="flex flex-wrap items-center gap-1 pt-1 border-t border-white/10 mt-1">
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Why override?"
                className="flex-1 min-w-[8rem] bg-black/40 border border-white/30 rounded px-1 py-0.5 text-[10px] text-white placeholder:text-amber-100/70"
                onClick={(e) => e.stopPropagation()}
              />
              <button
                type="button"
                disabled={override.isPending || override.isSuccess}
                onClick={(e) => { e.stopPropagation(); override.mutate(); }}
                className="text-[10px] px-1.5 py-0.5 rounded border border-white/30 hover:bg-white/10 disabled:opacity-50 text-white"
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
