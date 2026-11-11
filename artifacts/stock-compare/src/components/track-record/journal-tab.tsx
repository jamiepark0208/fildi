/**
 * Track Record › Journal (A393). Admin-only. Reads /api/trade-journal — never computes trades.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
import { TickerLink } from "@/components/ticker-link";

interface Row {
  orderId: string;
  at: string;
  day: string;
  symbol: string;
  kind: "stock" | "option";
  action: string;
  optionSide: "put" | "call" | null;
  strike: number | null;
  expiry: string | null;
  qty: number;
  px: number;
  premium: number;
  fees: number | null;
  status: string;
  pnl: number | null;
  pct: number | null;
  touched: boolean | null;
  matchedOpenDay: string | null;
  fildi: string;
  tag: string;
}
interface Sum { trades: number; winPct: number | null; pnl: number; avgPct: number | null }
interface Resp {
  days: number;
  count: number;
  summary: Sum & {
    byTag: Array<Sum & { tag: string }>;
    jamiePuts: { n: number; avgPct: number | null };
    enginePass: { n: number; avgPct: number | null };
  };
  rows: Row[];
}

const money = (v: number | null) => (v == null ? "—" : `${v < 0 ? "−" : "+"}$${Math.abs(Math.round(v)).toLocaleString()}`);
const pct = (v: number | null, d = 2) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}%`);
const tone = (v: number | null) => (v == null ? "text-amber-100" : v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "text-white");

function Stat({ label, value, sub, tip, cls }: { label: string; value: string; sub?: string; tip: string; cls?: string }) {
  return (
    <div className="rounded border border-[#d4af37]/15 bg-zinc-950/80 px-2.5 py-1 min-w-[96px]">
      <DataTip tip={tip}>
        <div className="text-[9px] uppercase tracking-wide text-[#d4af37]">{label}</div>
      </DataTip>
      <div className={cn("text-sm font-bold tabular-nums", cls)}>{value}</div>
      {sub && <div className="text-[9px] text-amber-100 truncate">{sub}</div>}
    </div>
  );
}

function Seg<T extends string | number>({ value, set, opts }: { value: T; set: React.Dispatch<React.SetStateAction<T>>; opts: Array<[T, string]> }) {
  return (
    <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[10px] font-semibold">
      {opts.map(([v, l]) => (
        <button
          key={String(v)}
          type="button"
          onClick={() => set(v)}
          className={cn("px-2 py-0.5", value === v ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white hover:text-[#d4af37]")}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function JournalTab() {
  const [days, setDays] = useState(90);
  const [kind, setKind] = useState<"all" | "stock" | "option">("all");
  const [state, setState] = useState<"all" | "open" | "closed">("all");
  const { data, isLoading, isError } = useQuery({
    queryKey: ["trade-journal", days],
    queryFn: async (): Promise<Resp> => {
      const res = await fetch(`/api/trade-journal?days=${days}`);
      if (!res.ok) throw new Error("trade-journal fetch failed");
      return res.json();
    },
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter(
        (r) =>
          (kind === "all" || r.kind === kind) &&
          (state === "all" || (state === "open" ? r.status === "open" : r.status !== "open")),
      ),
    [data, kind, state],
  );

  if (isLoading) return <div className="text-xs text-amber-200/70 py-10 text-center">Loading…</div>;
  if (isError || !data) return <div className="text-xs text-rose-300 py-10 text-center">Journal unavailable.</div>;
  const s = data.summary;
  const gap = s.jamiePuts.avgPct != null && s.enginePass.avgPct != null ? s.jamiePuts.avgPct - s.enginePass.avgPct : null;

  return (
    <div className="space-y-2" data-testid="journal-tab">
      <div className="flex flex-wrap gap-1.5">
        <Stat label="Graded" value={String(s.trades)} sub={`${data.count} fills`} tip="Fills with a P&L: closes (realized, FIFO vs the matching open) and option opens still open or expired (premium − intrinsic at expiry, or last close)." />
        <Stat label="Win" value={s.winPct == null ? "—" : `${s.winPct.toFixed(0)}%`} tip="Share of graded rows with P&L > 0." />
        <Stat label="P&L" value={money(s.pnl)} cls={tone(s.pnl)} tip="Sum of graded P&L, $. Fees only where the broker reported them." />
        <Stat label="Avg % strike" value={pct(s.avgPct)} cls={tone(s.avgPct)} tip="Mean per-share P&L as % of strike (same unit as the rec scoreboard)." />
        <Stat
          label="Jamie vs engine"
          value={gap == null ? "—" : pct(gap)}
          cls={tone(gap)}
          sub={`${pct(s.jamiePuts.avgPct)} (n ${s.jamiePuts.n}) vs ${pct(s.enginePass.avgPct)} (n ${s.enginePass.n})`}
          tip="Short-put opens: your fills vs put-engine PASS recs (bid + 10% of spread) over the same window, graded the same way. Port of scripts/rec_scoreboard.py."
        />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Seg<number> value={days} set={setDays} opts={[[30, "30d"], [90, "90d"], [365, "365d"]]} />
        <Seg value={kind} set={setKind} opts={[["all", "All"], ["stock", "Stock"], ["option", "Option"]]} />
        <Seg value={state} set={setState} opts={[["all", "All"], ["open", "Open"], ["closed", "Closed"]]} />
        <span className="text-[10px] text-amber-100" data-testid="journal-count">{rows.length} rows</span>
        {s.byTag.length > 0 && (
          <DataTip tip={s.byTag.map((t) => `${t.tag}: n ${t.trades}, ${money(t.pnl)}, ${pct(t.avgPct)}`).join("\n")}>
            <span className="text-[10px] text-amber-100">by tag</span>
          </DataTip>
        )}
      </div>
      <div className={GRID_WRAP}>
        <table className="w-full">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={cn(GRID_TH, "text-left")}>Date</th>
              <th className={cn(GRID_TH, "text-left")}>Symbol</th>
              <th className={cn(GRID_TH, "text-left")}>Trade</th>
              <th className={cn(GRID_TH, "text-right")}>Fill</th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Realized on closes (FIFO vs the open); on opens, the unclosed remainder at expiry or last close.">P&amp;L $</DataTip></th>
              <th className={cn(GRID_TH, "text-right")}><DataTip tip="Per-share P&L as % of strike. Split guard skips grades when spot and close differ > 35%.">% strike</DataTip></th>
              <th className={cn(GRID_TH, "text-left")}><DataTip tip="Put-engine row for the symbol that day (pass / first failed gate / not scanned) and the Model List folders of the latest run on or before the date.">Fildi said</DataTip></th>
              <th className={cn(GRID_TH, "text-left")}><DataTip tip="Auto tag from the engine's market/stock state that day.">Tag</DataTip></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.orderId} className={gridRow(i)} data-testid="journal-row">
                <td className={cn(GRID_TD, "whitespace-nowrap")}>{r.day.slice(5)}</td>
                <td className={GRID_TD}><TickerLink ticker={r.symbol} returnLabel="Journal" /></td>
                <td className={cn(GRID_TD, "whitespace-nowrap")}>
                  <DataTip tip={r.matchedOpenDay ? `Closes the ${r.matchedOpenDay} open.` : r.touched == null ? undefined : `Strike touched: ${r.touched ? "yes" : "no"}`}>
                    {r.kind === "option"
                      ? `${r.qty}× ${r.action} ${r.strike} ${r.expiry?.slice(5) ?? ""}`
                      : `${r.qty} ${r.action}`}
                  </DataTip>
                  {r.kind === "option" && r.status !== "closes" && <span className="ml-1 text-[9px] text-amber-100">{r.status}</span>}
                </td>
                <td className={cn(GRID_TD, "text-right")}>
                  <DataTip tip={`Cash ${money(r.premium).replace(/^[+]/, "")}${r.fees != null ? ` · fees $${r.fees}` : ""}`}>{r.px.toFixed(2)}</DataTip>
                </td>
                <td className={cn(GRID_TD, "text-right", tone(r.pnl))}>{money(r.pnl)}</td>
                <td className={cn(GRID_TD, "text-right", tone(r.pct))}>{pct(r.pct)}</td>
                <td className={cn(GRID_TD, "text-white")}>{r.fildi}</td>
                <td className={cn(GRID_TD, "text-amber-100")}>{r.tag}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="text-xs text-amber-100 py-6 text-center">No fills.</div>}
      </div>
    </div>
  );
}
