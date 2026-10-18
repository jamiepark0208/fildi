/**
 * A76 — PM Book card + Expiry desk (what-if). Data from GET /api/pm/book (book-latest.json).
 * Display only — no scoring / no trade actions.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

export type PmAccount = {
  account: string;
  type: string;
  equity: number;
  cash: number;
  buying_power: number;
  assign_if_itm_now: number;
  crash_drop_pct: number;
  close_itm_cost: number;
  status: "red" | "amber" | "green" | string;
  maint_ratio_est?: number;
  headroom_now?: number;
  headroom_if_assigned?: number;
  headroom_crash?: number;
  /** A161 — MC loss quantiles + −10% scenario (provisional until Kupiec) */
  var?: {
    var95?: number | null;
    var99?: number | null;
    var95_pct?: number | null;
    method?: string;
    market_m10?: { loss: number; pct: number | null; label: string };
    disagree?: { hist_var95: number; mc_var95: number; rel: number } | null;
    calibrated?: boolean;
    note?: string;
  } | null;
};

export type PmPosition = {
  account: string;
  ticker: string;
  strike: number;
  expiry: string;
  qty: number;
  spot: number | null;
  itm: boolean;
  move_needed: number | null;
  p_otm: number | null;
  iv: number | null;
  close_cost: number;
  assign_cash: number;
  days_left: number;
  status: string;
};

export type PmBook = {
  generated: string;
  snapshot_at: string | null;
  live_priced_at: string | null;
  rules: { crash_move: number; crash_budget: number; crash_warn: number; bad_week_itm: number };
  accounts: Record<string, PmAccount>;
  positions: PmPosition[];
};

const STATUS_CHIP: Record<string, string> = {
  red: "border-red-500/50 text-red-300 bg-red-500/10",
  amber: "border-amber-400/50 text-amber-200 bg-amber-500/10",
  green: "border-emerald-500/40 text-emerald-300 bg-emerald-500/10",
};

function money(n: number, signed = false): string {
  const abs = Math.abs(n);
  const s = abs >= 1000 ? `$${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k` : `$${Math.round(abs)}`;
  if (!signed) return n < 0 ? `−${s.slice(1)}` : s;
  return n < 0 ? `−${s.slice(1)}` : `+${s.slice(1)}`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getMonth() + 1}/${d.getDate()} ${((d.getHours() + 11) % 12) + 1}:${String(d.getMinutes()).padStart(2, "0")}${d.getHours() < 12 ? "a" : "p"}`;
}

function isStale(iso: string | null | undefined): boolean {
  if (!iso) return true;
  const ageH = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  return ageH > 24; // ~1 trading day
}

function reasonLine(a: PmAccount, rules: PmBook["rules"]): string {
  const h = a.headroom_if_assigned;
  if (h != null && h < 0) {
    return `Assignment → margin call ${money(h, true)}`;
  }
  if (a.crash_drop_pct >= rules.crash_budget) {
    return `Crash week: −${pct(a.crash_drop_pct)} vs ${pct(rules.crash_budget)} budget`;
  }
  return `Assignment needs ${money(a.assign_if_itm_now)} vs cash ${money(a.cash)}`;
}

function posKey(p: PmPosition): string {
  return `${p.account}|${p.ticker}|${p.strike}|${p.expiry}`;
}

export function PmBookCard({ className, embedded = false }: { className?: string; embedded?: boolean }) {
  const { data, isError } = useQuery<{ book: PmBook | null }>({
    queryKey: ["pm-book"],
    queryFn: async () => {
      const r = await fetch("/api/pm/book", { credentials: "include" });
      if (r.status === 404) return { book: null };
      if (!r.ok) throw new Error("pm book");
      return r.json();
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  const book = data?.book ?? null;
  const nearExpiryItm = useMemo(
    () => (book?.positions ?? []).some((p) => p.itm && p.days_left <= 2),
    [book],
  );
  const [deskOpen, setDeskOpen] = useState<boolean | null>(null);
  const open = deskOpen ?? nearExpiryItm;

  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const toggle = (k: string) => {
    setClosed((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  };

  if (isError) {
    return (
      <div className={cn(
        "space-y-0.5",
        !embedded && "rounded-md border border-[#d4af37]/20 bg-zinc-950 px-3 py-2",
        className,
      )}>
        {!embedded && <div className="text-[10px] font-bold tracking-wide uppercase text-[#d4af37]">Book risk</div>}
        <p className="text-[11px] text-amber-200/50">Unavailable — check pm_alerts / API.</p>
      </div>
    );
  }
  if (!book) {
    return (
      <div className={cn(
        "space-y-0.5",
        !embedded && "rounded-md border border-[#d4af37]/20 bg-zinc-950 px-3 py-2",
        className,
      )}>
        {!embedded && <div className="text-[10px] font-bold tracking-wide uppercase text-[#d4af37]">Book risk</div>}
        <p className="text-[11px] text-amber-200/45">
          Not run yet — short-put stress (assignment + crash week) appears after the PM book job runs.
        </p>
      </div>
    );
  }

  const pricedAt = book.live_priced_at ?? book.snapshot_at;
  const stale = isStale(pricedAt);
  const accounts = Object.values(book.accounts);

  return (
    <div className={cn(
      "overflow-hidden",
      !embedded && "rounded-md border border-[#d4af37]/25 bg-zinc-950",
      className,
    )}>
      {!embedded && (
        <div className="px-2.5 pt-2 pb-1.5 border-b border-[#d4af37]/15 space-y-0.5">
          <div className="text-[10px] font-bold tracking-wide uppercase text-[#d4af37]">Book risk</div>
          <p className="text-[10px] text-amber-100/70 leading-snug">
            Read-only stress dashboard for short puts (not a close blotter). Top = per-account traffic lights.
            Expiry desk = what-if checkboxes only — nothing is sent to the broker.
          </p>
        </div>
      )}
      <div className={cn("space-y-1.5", !embedded && "px-2.5 py-1.5")}>
        {/* IRA + FILDI side-by-side — fill the row instead of stacking */}
        <div className={cn(
          "gap-x-4 gap-y-2",
          accounts.length >= 2 ? "grid grid-cols-2" : "grid grid-cols-1",
        )}>
          {accounts.map((a) => {
            const drop = a.crash_drop_pct;
            const warn = book.rules.crash_warn;
            const budget = book.rules.crash_budget;
            const barPct = Math.min(100, (drop / Math.max(budget * 1.4, 0.01)) * 100);
            return (
              <div key={a.account} className="min-w-0 rounded border border-[#d4af37]/10 bg-black/20 px-2 py-1.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={cn("shrink-0 rounded border px-1 text-[9px] font-semibold uppercase", STATUS_CHIP[a.status] ?? STATUS_CHIP.amber)}>
                    {a.account}
                  </span>
                  <span className="truncate text-[11px] text-amber-100/85">{reasonLine(a, book.rules)}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] tabular-nums text-amber-200/55">
                  <span>cash {money(a.cash)}</span>
                  <span>assign {money(a.assign_if_itm_now)}</span>
                  <span className="inline-flex items-center gap-1.5 min-w-0">
                    <span className="shrink-0">crash −{pct(drop)}</span>
                    <span className="relative h-1.5 w-14 shrink-0 rounded-full bg-zinc-800 overflow-hidden">
                      <span
                        className={cn("absolute inset-y-0 left-0 rounded-full", drop >= budget ? "bg-red-500" : drop >= warn ? "bg-amber-400" : "bg-emerald-500")}
                        style={{ width: `${barPct}%` }}
                      />
                      <span className="absolute inset-y-0 w-px bg-amber-200/40" style={{ left: `${(warn / (budget * 1.4)) * 100}%` }} />
                      <span className="absolute inset-y-0 w-px bg-red-400/50" style={{ left: `${(budget / (budget * 1.4)) * 100}%` }} />
                    </span>
                  </span>
                </div>
                {a.var?.var95 != null && (
                  <div
                    className="mt-0.5 text-[10px] tabular-nums text-amber-100/70 leading-snug"
                    title={[a.var.note, a.var.market_m10?.label, a.var.method].filter(Boolean).join(" · ")}
                  >
                    95% VaR {money(a.var.var95)}
                    {a.var.var99 != null ? ` · 99% ${money(a.var.var99)}` : ""}
                    {a.var.market_m10?.loss != null ? ` · −10% ${money(a.var.market_m10.loss)}` : ""}
                    {!a.var.calibrated ? " · provisional" : ""}
                    {a.var.disagree ? ` · hist disagrees ${(a.var.disagree.rel * 100).toFixed(0)}%` : ""}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className={cn("text-[9px] tabular-nums", stale ? "text-red-400" : "text-amber-200/35")}>
          priced {shortWhen(pricedAt)}{stale ? " · stale" : ""}
        </div>
      </div>

      {/* Expiry desk */}
      <div className="border-t border-[#d4af37]/20">
        <button
          type="button"
          onClick={() => setDeskOpen(!open)}
          className="w-full px-2.5 py-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-[#d4af37]/80 hover:bg-white/5"
        >
          <span>What-if closes{nearExpiryItm ? " · ITM ≤2d" : ""}</span>
          <span className="text-amber-200/40">{open ? "▾" : "▸"}</span>
        </button>
        {open && (
          <ExpiryDesk book={book} closed={closed} onToggle={toggle} />
        )}
      </div>
    </div>
  );
}

function ExpiryDesk({
  book, closed, onToggle,
}: {
  book: PmBook;
  closed: Set<string>;
  onToggle: (k: string) => void;
}) {
  const byAcct = useMemo(() => {
    const m = new Map<string, PmPosition[]>();
    for (const p of book.positions) {
      if (!m.has(p.account)) m.set(p.account, []);
      m.get(p.account)!.push(p);
    }
    return m;
  }, [book.positions]);

  return (
    <div className="px-2 pb-2 space-y-2">
      <p className="text-[9px] text-amber-200/45 px-0.5 leading-snug">
        Checkboxes are a calculator only — they do not close trades. Tick names you might buy back;
        the line below updates cash/margin headroom. P(OTM) = market odds from the option&apos;s IV, not a forecast.
      </p>
      {[...byAcct.entries()].map(([acct, rows]) => {
        const a = book.accounts[acct];
        if (!a) return null;
        const checked = rows.filter((p) => closed.has(posKey(p)));
        const assignChecked = checked.reduce((s, p) => s + p.assign_cash, 0);
        const closeChecked = checked.reduce((s, p) => s + p.close_cost, 0);
        const isMargin = a.headroom_if_assigned != null && a.maint_ratio_est != null;
        let afterLabel = "";
        let afterVal = 0;
        if (isMargin) {
          afterVal = (a.headroom_if_assigned ?? 0) + (a.maint_ratio_est ?? 0) * assignChecked;
          afterLabel = "headroom after";
        } else {
          afterVal = a.cash - a.assign_if_itm_now + assignChecked - closeChecked;
          afterLabel = "cash after assign";
        }
        return (
          <div key={acct} className="min-w-0">
            <div className="mb-0.5 flex items-baseline justify-between gap-2 min-w-0">
              <span className="text-[10px] font-semibold text-amber-100/80 shrink-0">{acct}</span>
              <span className="text-[10px] tabular-nums text-amber-100/75 truncate text-right">
                {afterLabel}{" "}
                <span className={cn("font-semibold", afterVal < 0 ? "text-red-300" : "text-emerald-300")}>
                  {money(afterVal, true)}
                </span>
                <span className="text-amber-200/40 ml-1.5">close {money(closeChecked)}</span>
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[10px] min-w-[320px]">
                <thead>
                  <tr className="text-amber-200/40 text-left">
                    <th className="font-medium py-0.5 pr-1 w-5" />
                    <th className="font-medium py-0.5 pr-1">Tkr</th>
                    <th className="font-medium py-0.5 pr-1 text-right">K</th>
                    <th className="font-medium py-0.5 pr-1 text-right">needs</th>
                    <th className="font-medium py-0.5 pr-1 text-right">P(OTM)</th>
                    <th className="font-medium py-0.5 pr-1 text-right">close</th>
                    <th className="font-medium py-0.5 text-right">assign</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const k = posKey(p);
                    const on = closed.has(k);
                    return (
                      <tr key={k} className={cn("border-t border-zinc-800/80", p.itm && p.days_left <= 2 && "bg-red-500/5")}>
                        <td className="py-0.5 pr-1">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => onToggle(k)}
                            title="What-if: pretend this put is closed (does not trade)"
                            className="accent-[#d4af37]"
                          />
                        </td>
                        <td className="py-0.5 pr-1 font-medium text-amber-100">{p.ticker}</td>
                        <td className="py-0.5 pr-1 text-right tabular-nums text-amber-200/70">{p.strike}</td>
                        <td className="py-0.5 pr-1 text-right tabular-nums text-amber-200/60">
                          {p.move_needed == null ? "—" : `+${(p.move_needed * 100).toFixed(0)}%`}
                        </td>
                        <td className="py-0.5 pr-1 text-right tabular-nums text-amber-200/60">
                          {p.p_otm == null ? "—" : `${(p.p_otm * 100).toFixed(0)}%`}
                        </td>
                        <td className="py-0.5 pr-1 text-right tabular-nums text-amber-200/60">{money(p.close_cost)}</td>
                        <td className="py-0.5 text-right tabular-nums text-amber-200/60">{money(p.assign_cash)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}
