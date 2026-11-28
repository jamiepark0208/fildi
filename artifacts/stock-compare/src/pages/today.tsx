// Today (Jamie 11-17): one page for "is Fildi running, what fired, what should I look at" — ordered by importance:
// run status → signals firing (with their backtest number) → the ranked Today list → every put idea (best first, then
// ≥ 80 %-odds options with their cautions; Jamie decides). Data: GET /api/today/overview + /api/trade-funnel/today.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import type { BookGroupAwareness } from "@/lib/model-list-awareness";
import { GRID_WRAP, GRID_HEADER, GRID_TH } from "@/lib/score-explain-format";
import { TodayTradesCard } from "@/components/live/today-trades-card";
import { RiskReversalCard } from "@/components/live/risk-reversal-card";
import { DeepRiskReversalCard } from "@/components/live/deep-rr-card";
import { BookRiskCard } from "@/components/live/book-risk-card";

const TH = cn(GRID_TH, "px-1.5 py-0.5");
const TD = "px-1.5 py-0.5 text-[11px] font-mono";

type Signal = {
  id: string; name: string; trade: string; backtest: string; study: string;
  lastFired: string | null; firingNames: number; daysFiredLast7: number; names: string[]; keys: string[]; unseen: number; caution: string | null;
};
type Put = {
  ticker: string; rank: number; tier: string; strike: number | null; expiry: string | null; bid: number | null;
  oddsOtm: number | null; incomeWkPct: number | null; why: string | null; cautions: string[]; key: string; seen: boolean;
  bookGroup?: BookGroupAwareness | null;
};

/** A407 sector flag (Jamie 11-17: flag, never cap): other ideas today + held names that move with this one (6-mo corr ≥ 0.5). */
function movesWith(bg: BookGroupAwareness | null | undefined): { label: string; tip: string; hot: boolean } | null {
  const others = (bg?.list?.length ?? 0) - 1;
  const held = bg?.held?.length ?? 0;
  if (!bg || (others < 1 && held < 1)) return null;
  const label = [others > 0 && `${others} idea${others > 1 ? "s" : ""}`, held > 0 && `${held} held`].filter(Boolean).join(" · ");
  const tip = `Moves with (avg 6-mo daily corr ${bg.corr}): ${bg.list.join(", ")}`
    + `${held ? `\nYou hold: ${bg.held.join(", ")}` : ""}\n${bg.same_expiry} of ${bg.of_list} ideas share this expiry. A sell-off hits them together.`;
  return { label, tip, hot: others + held >= 3 };
}
type Overview = {
  status: { lastRun: { at: string | null; status: string | null; failed: string[] }; asOf: Record<string, string | null> };
  signals: Signal[];
  puts: Put[];
  seen7d: { fired: number; seen: number; bySignal: Record<string, { fired: number; seen: number }> };
  bottom?: { asOf: string | null; checks: Check[]; series?: { ratio: { date: string; value: number }[]; hy: { date: string; value: number }[] } };
};
type Check = { key: string; label: string; value: string; read: "up" | "down" | "wait"; why: string };


type LongCall = {
  account: string; ticker: string; strike: number; expiry: string; days: number; qty: number; cost: number; mark: number | null;
  breakeven: number; spot: number | null; spotDate: string | null; moveToBe: number | null; sdMove: number | null;
  pBreakeven: number | null; pTouch: number | null; pItm: number | null; valueLeft: number | null; paid: number; thetaDay: number | null;
};
const pc = (v: number | null, d = 0) => (v == null ? "—" : `${(v * 100).toFixed(d)} %`);
const usd = (v: number | null) => (v == null ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(Math.round(v)).toLocaleString()}`);

// Jamie 11-17 (S198): odds each open long call ends above breakeven — the call is the bet, so show what it needs.
function LongCallOdds() {
  const { data } = useQuery<{ rows: LongCall[]; snapAt: string | null }>({
    queryKey: ["today-long-calls"],
    queryFn: async () => {
      const r = await fetch("/api/today/long-calls", { credentials: "include" });
      if (!r.ok) throw new Error(`long-calls ${r.status}`);
      return r.json();
    },
    staleTime: 10 * 60_000,
  });
  if (!data?.rows.length) return null;
  const paid = data.rows.reduce((a, r) => a + r.paid, 0), left = data.rows.reduce((a, r) => a + (r.valueLeft ?? 0), 0);
  const burn = data.rows.reduce((a, r) => a + (r.thetaDay ?? 0), 0);
  return (
    <div className={GRID_WRAP} data-testid="today-long-calls">
      <div className={cn(GRID_HEADER, "px-1.5")} title={`Market odds from each option's own IV (Robinhood snapshot ${data.snapAt?.slice(0, 16) ?? "?"}), no drift — not a forecast. Touch ≈ 2 × end-above (you can sell before expiry if it gets there). S198 history: 1-month calls on crashed high-beta names ended above breakeven 7–26 % of the time.`}>
        Your open long calls — odds to breakeven · paid {usd(paid)} · worth {usd(left)} · time decay {usd(burn)}/day
      </div>
      <table className="w-full">
        <thead><tr>
          {["Ticker", "Strike · expiry", "Days", "Spot", "Breakeven", "Move needed", "1σ move", "Ends above BE", "Touches BE", "Paid → now", "Decay/day", "Acct"].map((h) => <th key={h} className={TH}>{h}</th>)}
        </tr></thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={`${r.account}-${r.ticker}-${r.strike}-${r.expiry}`} className="border-t border-white/5"
              title={`Needs ${r.ticker} at ${r.breakeven.toFixed(2)} by ${r.expiry} (strike + ${r.cost.toFixed(2)} paid). Odds it ends in the money at all: ${pc(r.pItm)}. Spot = close ${r.spotDate ?? "?"}.`}>
              <td className={cn(TD, "text-left font-semibold")}>{r.ticker}</td>
              <td className={TD}>{r.strike}C {r.expiry.slice(5)}</td>
              <td className={TD}>{r.days}</td>
              <td className={TD}>{r.spot?.toFixed(2) ?? "—"}</td>
              <td className={TD}>{r.breakeven.toFixed(2)}</td>
              <td className={TD}>{r.moveToBe == null ? "—" : `${r.moveToBe >= 0 ? "+" : ""}${(r.moveToBe * 100).toFixed(0)} %`}</td>
              <td className={TD}>±{pc(r.sdMove)}</td>
              <td className={cn(TD, "font-semibold", (r.pBreakeven ?? 0) >= 0.4 ? "text-green-400" : (r.pBreakeven ?? 0) >= 0.2 ? "text-amber-300" : "text-red-400")}>{pc(r.pBreakeven)}</td>
              <td className={TD}>{pc(r.pTouch)}</td>
              <td className={TD}>{usd(r.paid)} → {usd(r.valueLeft)}</td>
              <td className={cn(TD, "text-red-300/80")}>{usd(r.thetaDay)}</td>
              <td className={cn(TD, "text-amber-100")}>{r.account}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Jamie 11-17 ("how will you know it's time to get long?"): no forecast — four reads that build or kill conviction.
// Unread = bright yellow until clicked (Jamie 11-17: "verify that I have truly read the recommendation").
const UNSEEN = "bg-yellow-300/25 outline outline-1 outline-yellow-300/70 cursor-pointer";
type MarkSeen = (keys: string[]) => void;

function ageH(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.replace(" ", "T"));
  return Number.isFinite(t) ? (Date.now() - t) / 3_600_000 : null;
}

function StatusStrip({ s, seen }: { s: Overview["status"]; seen: Overview["seen7d"] }) {
  const h = ageH(s.lastRun.at);
  const ok = s.lastRun.status === "ok" && h != null && h < 30;
  return (
    <div className={cn(GRID_WRAP, "flex flex-wrap items-baseline gap-x-3 px-2 py-1 text-[11px]")} data-testid="today-status">
      <span className={cn("font-semibold", ok ? "text-green-400" : "text-amber-400")}>
        {ok ? "● Fildi is running" : "● Daily run needs a look"}
      </span>
      <span className="text-amber-200/60">
        last daily run {s.lastRun.at?.slice(5, 16).replace("T", " ") ?? "—"} ({s.lastRun.status ?? "unknown"}
        {s.lastRun.failed.length ? `, failed: ${s.lastRun.failed.join(", ")}` : ""})
      </span>
      <span className="text-amber-200/60">put ideas {s.asOf.putIdeas?.slice(5, 16) ?? "—"}</span>
      <span className="text-amber-200/60">signals {s.asOf.signals?.slice(5) ?? "—"}</span>
      <span className="text-amber-200/60">Today list {s.asOf.todayList?.slice(5) ?? "—"}</span>
      <span className={seen.seen < seen.fired ? "text-yellow-300" : "text-green-400"} title="Signal fires (rule × name × day) in the last 7 days that you clicked. Yellow rows = not read yet.">
        seen {seen.seen} of {seen.fired} signal fires this week
      </span>
    </div>
  );
}

function SignalsTable({ rows, mark, by }: { rows: Signal[]; mark: MarkSeen; by: Overview["seen7d"]["bySignal"] }) {
  const sorted = [...rows].sort((a, b) => b.firingNames - a.firingNames || String(b.lastFired).localeCompare(String(a.lastFired)));
  return (
    <section className={GRID_WRAP} data-testid="today-signals">
      <div className={cn(GRID_HEADER, "px-1.5")} title="Every rule that passed a backtest (research/studies/BOARD.md 'Works') plus paper rules being graded. Firing = names on the latest signal day.">
        <span className="font-semibold">Signals</span>
        <span className="ml-2 text-[10px] text-amber-200/50">what fired, and what it earned in the backtest</span>
      </div>
      <table className="w-full">
        <thead>
          <tr>{["Signal", "Firing now", "Last fired", "Trade", "Backtest"].map((h) => <th key={h} className={cn(TH, "text-left")}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.id} className={cn("border-t border-white/5", s.unseen > 0 && UNSEEN)} onClick={() => s.unseen > 0 && mark(s.keys)}
              title={`${s.study} · fired on ${s.daysFiredLast7} of the last 7 days · you saw ${by[s.id]?.seen ?? 0} of ${by[s.id]?.fired ?? 0} fires this week${s.unseen ? " — click to mark read" : ""}`}>
              <td className={cn(TD, "text-white")}>{s.name}</td>
              <td className={cn(TD, s.firingNames ? "text-green-400" : "text-amber-200/40")}>
                {s.firingNames ? `${s.firingNames}: ${s.names.join(", ")}${s.firingNames > s.names.length ? " …" : ""}` : "—"}
              </td>
              <td className={TD}>{s.lastFired?.slice(5) ?? "never"}</td>
              <td className={cn(TD, "text-amber-100/80")}>{s.trade}</td>
              <td className={cn(TD, "text-amber-200/60 max-w-[380px]")} title={s.caution ? `${s.backtest}\n${s.caution}` : s.backtest}>
                <div className="truncate">{s.backtest}</div>
                {s.caution && <div className="truncate text-orange-300" data-testid="signal-caution">⚠ {s.caution}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function PutIdeas({ rows, mark }: { rows: Put[]; mark: MarkSeen }) {
  const [all, setAll] = useState(false);
  const best = rows.filter((r) => r.tier === "best").length;
  const shown = all ? rows : rows.slice(0, 30);
  return (
    <section className={GRID_WRAP} data-testid="today-puts">
      <div className={cn(GRID_HEADER, "px-1.5")} title="Best = passes every tested gate (the live strategy). Option = ≥ 80 % odds of expiring worthless but misses a gate — the caution says which. Ranked best first, then by the engine's edge.">
        <span className="font-semibold">Sell-put ideas</span>
        <span className="ml-2 text-[10px] text-amber-200/50">{best} best · {rows.length - best} options (≥ 80 % odds) — you decide</span>
      </div>
      <table className="w-full">
        <thead>
          <tr>{["#", "Ticker", "Strike", "Exp", "Odds", "%/wk", "Tier", "Moves with", "Caution"].map((h) => <th key={h} className={cn(TH, h === "Caution" ? "text-left" : "")}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.ticker} className={cn("border-t border-white/5", !p.seen && p.tier === "best" && UNSEEN)}
              onClick={() => !p.seen && mark([p.key])} title={(p.why ?? "") + (!p.seen ? " — click to mark read" : "")}>
              <td className={cn(TD, "text-amber-200/40")}>{p.rank}</td>
              <td className={cn(TD, "text-white")}>{p.ticker}</td>
              <td className={cn(TD, "text-right")}>{p.strike != null ? Number(p.strike).toFixed(1) : "—"}</td>
              <td className={TD}>{p.expiry ? String(p.expiry).slice(5, 10) : "—"}</td>
              <td className={cn(TD, "text-right")}>{p.oddsOtm != null ? `${Math.round(100 * p.oddsOtm)} %` : "—"}</td>
              <td className={cn(TD, "text-right")}>{p.incomeWkPct != null ? p.incomeWkPct.toFixed(2) : "—"}</td>
              <td className={cn(TD, p.tier === "best" ? "text-green-400" : "text-sky-300")}>{p.tier}</td>
              <td className={cn(TD, "whitespace-nowrap")}>
                {(() => { const m = movesWith(p.bookGroup); return m
                  ? <DataTip tip={m.tip}><span className={m.hot ? "text-amber-300" : "text-white"}>{m.label}</span></DataTip>
                  : <span>—</span>; })()}
              </td>
              <td className={cn(TD, "text-left text-amber-200/60 max-w-[360px] truncate")} title={p.cautions.join("\n")}>
                {p.cautions[0] ?? ""}{p.cautions.length > 1 ? ` (+${p.cautions.length - 1})` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > 30 && (
        <button className="px-1.5 text-[10px] text-sky-300/70 hover:text-sky-300" onClick={() => setAll(!all)}>
          {all ? "show top 30" : `show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

export default function Today() {
  const { data, error } = useQuery<Overview>({
    queryKey: ["today-overview"],
    queryFn: async () => {
      const r = await fetch("/api/today/overview", { credentials: "include" });
      if (!r.ok) throw new Error(`today ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  const qc = useQueryClient();
  const seen = useMutation({
    mutationFn: async (keys: string[]) => {
      const r = await fetch("/api/today/seen", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keys }) });
      if (!r.ok) throw new Error(`seen ${r.status}`);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["today-overview"] }),
  });
  const mark: MarkSeen = (keys) => keys.length && seen.mutate(keys);
  return (
    <div className="mx-auto max-w-[1400px] space-y-2 px-3 pb-8 pt-16" data-testid="today-page">
      {error && <div className="text-[11px] text-red-400">Today overview failed to load: {String(error)}</div>}
      {data && <StatusStrip s={data.status} seen={data.seen7d} />}
      {/* Jamie 11-20: decisions only, by importance; market context (bottom checklist, fear curve, tenor cost) → Live › Market */}
      <BookRiskCard />
      {data && <SignalsTable rows={data.signals} mark={mark} by={data.seen7d.bySignal} />}
      <TodayTradesCard n={20} />
      {data && <PutIdeas rows={data.puts} mark={mark} />}
      <RiskReversalCard />
      <DeepRiskReversalCard />
      <LongCallOdds />
    </div>
  );
}
