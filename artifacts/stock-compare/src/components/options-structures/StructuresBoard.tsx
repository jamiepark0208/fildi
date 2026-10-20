/**
 * Rankings › Strategies (A192). Every major option structure: what it is, when it fits, what our studies say, and today's ≤ 5 names.
 * Data: GET /api/options/structures (nightly table from scripts/watchlist_sync/structures.py, real Schwab ladders, realistic fills).
 * Structures that failed on Jamie's own trades (S020/S061) are described but never ranked; untested ones are ranked and say so.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Leg = { side: "put" | "call"; strike: number; expiry: string; qty: number; px: number; bid: number; ask: number; iv: number };
type Row = {
  ticker: string; spot: number; expiry: string; dte: number; legs: Leg[]; credit: number; capital: number; max_loss: number | null;
  max_gain: number | null; p_mkt: number; p_rv: number; ev_mkt: number; ev_rv: number; ev_rv_cap: number; worst5?: number; iv_rv: number;
  fit_why: string; edge_q: number | null;
};
type Structure = { id: string; name: string; family: string; description: string; regime: string; evidence: string; evidenceNote: string; rows: Row[] };
type Board = { asOf: string | null; stance: string | null; structures: Structure[] };

const BADGE: Record<string, { label: string; cls: string }> = {
  pass: { label: "Tested ✓", cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30" },
  untested: { label: "Untested", cls: "bg-amber-500/10 text-amber-200 border-amber-500/30" },
  fail: { label: "Failed on your trades", cls: "bg-red-500/10 text-red-300 border-red-500/30" },
};

const usd = (v: number | null | undefined) => (v == null ? "—" : `$${Math.abs(v * 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`);
const pct = (v: number | null | undefined, d = 0) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
const legText = (l: Leg) => `${l.qty > 0 ? "Buy" : "Sell"} ${l.strike}${l.side === "put" ? "P" : "C"} ${l.expiry.slice(5)}`;

export function StructuresBoard() {
  const { data, isLoading } = useQuery({
    queryKey: ["options-structures"],
    queryFn: async (): Promise<Board> => {
      const r = await fetch("/api/options/structures", { credentials: "include" });
      if (!r.ok) throw new Error("structures fetch failed");
      return r.json();
    },
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (isLoading) return <p className="text-sm text-muted-foreground">Loading strategies…</p>;
  if (!data?.structures.length) return <p className="text-sm text-muted-foreground">No strategies board yet (runs each morning).</p>;
  const ranked = data.structures.filter((s) => s.rows.length > 0);
  const toggle = (id: string) => setOpen((o) => { const n = new Set(o); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <div className="space-y-2 text-xs">
      <div className="rounded border border-[#d4af37]/25 bg-zinc-950 p-2">
        <div className="text-[#d4af37] font-semibold">Today {data.asOf ?? ""} · {ranked.length} strategies with picks · each ticker shown once</div>
        {data.stance && <div className="text-amber-100/80 mt-0.5">{data.stance}</div>}
        <div className="text-amber-200/40 mt-1" title="Priced from today's real Schwab quotes. Fill = bid + 23 % of the spread when selling, ask − 23 % when buying (your measured Robinhood fills). Win odds at the market's IV; expected value from the stock's own 2-year moves over the same days (keeps jumps/earnings gaps). Names with earnings before expiry are excluded.">
          Real quotes · realistic fills · EV from each stock's own 2-year moves ⓘ
        </div>
      </div>
      {data.structures.map((s) => {
        const b = BADGE[s.evidence] ?? BADGE.untested;
        // strategies with picks start open; a click flips the default either way
        const isOpen = (s.rows.length > 0) !== open.has(s.id);
        return (
          <div key={s.id} className="rounded border border-white/10 bg-zinc-950/60">
            <button type="button" onClick={() => toggle(s.id)} className="w-full flex items-center gap-2 px-2 py-1.5 text-left">
              {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-[#d4af37]" /> : <ChevronRight className="w-3.5 h-3.5 text-[#d4af37]" />}
              <span className="font-semibold text-white">{s.name}</span>
              <span className={cn("px-1.5 rounded border text-[10px]", b.cls)} title={s.evidenceNote}>{b.label}</span>
              <span className="text-amber-200/50 ml-auto">{s.rows.length ? `${s.rows.length} pick${s.rows.length > 1 ? "s" : ""}` : s.evidence === "fail" ? "not ranked" : "no fit today"}</span>
            </button>
            {isOpen && (
              <div className="px-2 pb-2 space-y-1.5">
                <div className="text-amber-100/80">{s.description}</div>
                <div className="text-amber-200/60"><span className="text-amber-200/40">When it fits:</span> {s.regime}</div>
                <div className="text-amber-200/60"><span className="text-amber-200/40">Our evidence:</span> {s.evidenceNote}</div>
                {s.rows.length > 0 && (
                  <table className="w-full mt-1">
                    <thead className="text-[10px] uppercase text-amber-200/40">
                      <tr>
                        <th className="text-left font-normal">Ticker</th><th className="text-left font-normal">Legs</th>
                        <th className="text-right font-normal" title="Net credit (+) or debit (−) per contract at realistic fills">Credit</th>
                        <th className="text-right font-normal" title="Cash / margin at risk per contract">Capital</th>
                        <th className="text-right font-normal" title="Chance of any profit at expiry, at the market's own IV">Win odds</th>
                        <th className="text-right font-normal" title="Expected pnl ÷ capital using the stock's own 2-year moves over the same number of days">EV / capital</th>
                        <th className="text-right font-normal" title="Worst 5 % outcome ÷ capital (same history)">Bad case</th>
                        <th className="text-left font-normal pl-2">Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.rows.map((r) => (
                        <tr key={r.ticker} className="border-t border-white/5">
                          <td className="py-1 font-mono text-white">{r.ticker}<span className="text-amber-200/40"> ${r.spot.toFixed(2)}</span></td>
                          <td className="py-1 text-amber-100/80">{r.legs.map(legText).join(" · ")}</td>
                          <td className={cn("py-1 text-right font-mono", r.credit >= 0 ? "text-emerald-300" : "text-red-300")}>{r.credit >= 0 ? "+" : "−"}{usd(r.credit)}</td>
                          <td className="py-1 text-right font-mono">{usd(r.capital)}</td>
                          <td className="py-1 text-right font-mono">{pct(r.p_mkt)}</td>
                          <td className="py-1 text-right font-mono text-emerald-300">{pct(r.ev_rv_cap, 1)}</td>
                          <td className="py-1 text-right font-mono text-red-300">{pct(r.worst5, 0)}</td>
                          <td className="py-1 pl-2 text-amber-200/60">{r.dte}d · {r.fit_why}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
