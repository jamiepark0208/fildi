/**
 * Today's structure picks (A192) — table inside StructureLab expand.
 * Click a row → parent updates payoff + metrics (selection owned by StructureLab).
 */
import { type ReactNode, memo } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
import { formatMd } from "@/lib/format";
import { TickerLink } from "@/components/ticker-link";
import { AddToTicket } from "@/components/trade-ticket/TicketButtons";

export type StructureLeg = {
  side: "put" | "call"; strike: number; expiry: string; qty: number; px: number; bid: number; ask: number; iv: number;
};
export type StructurePick = {
  ticker: string; spot: number; expiry: string; dte: number; legs: StructureLeg[]; credit: number; capital: number;
  max_loss: number | null; max_gain: number | null; p_mkt: number; p_rv: number; ev_mkt: number; ev_rv: number;
  ev_rv_cap: number; worst5?: number; iv_rv: number; fit_why: string; edge_q: number | null;
  /** primary · more · margin (strangle/straddle) · study (S076-fail priced example) */
  tier?: "primary" | "more" | "margin" | "study";
};
export type StructureMeta = {
  id: string; name: string; family: string; description: string; regime: string; evidence: string;
  evidenceNote: string; rows: StructurePick[];
  /** A192 V2: realized track record (structure_grades.py) — primary picks and all tiers */
  grade?: { asOf?: string; primary?: StructureGrade; all?: StructureGrade } | null;
};
export type StructureGrade = {
  n: number; entry_dates: number; expiries: number; first: string; last_expiry: string;
  pred_mean: number | null; real_mean: number; real_median: number; win: number;
  rho: number | null; rho_within_date: number | null; ci_cluster: [number, number] | null;
  n_big: number; real_mean_ex_big: number | null; one_regime: boolean; ledger_matched: number;
};

const pctG = (x: number | null | undefined) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${Math.round(100 * x)}%`);

/** A192 V2: how this structure's past board picks actually did, in the board's own units (P&L ÷ capital, whole trade). */
function TrackRecord({ structureId }: { structureId: string }) {
  const { data } = useStructuresBoard();
  const gr = data?.structures.find((s) => s.id === structureId)?.grade;
  const g = gr?.primary ?? gr?.all;
  if (!g) return null;
  const scope = gr?.primary ? "Today-tier picks" : "All tiers (incl. study)";
  const early = g.expiries < 3 || g.one_regime;
  const tip = [
    `${scope} since ${g.first}, graded at each expiry close (last ${g.last_expiry}). Graded ${gr?.asOf ?? "—"}.`,
    `${g.n} trades · ${g.entry_dates} entry days · ${g.expiries} expiries. Expiries share market risk, so they are the real sample size.`,
    `Median ${pctG(g.real_median)}. Range of the average across expiries: ${g.ci_cluster ? `${pctG(g.ci_cluster[0])} to ${pctG(g.ci_cluster[1])}` : "needs ≥ 3 expiries"}.`,
    `Does the board's ranking order results? rank correlation ${g.rho ?? "—"} (same day: ${g.rho_within_date ?? "—"}). 0 = no, 1 = perfect.`,
    g.n_big ? `${g.n_big} moves > 60 % kept (no split on record); without them ${pctG(g.real_mean_ex_big)}.` : "",
    gr?.all && gr?.primary ? `All tiers: ${gr.all.n} trades, avg ${pctG(gr.all.real_mean)}, won ${pct(gr.all.win)}.` : "",
  ].filter(Boolean).join("\n");
  return (
    <div className="text-[11px] text-white px-1">
      <DataTip tip={tip}>
        <span>
          Track record: {g.n} trades, avg {pctG(g.real_mean)} vs predicted {pctG(g.pred_mean)}, won {pct(g.win)}
        </span>
      </DataTip>
      {early && (
        <span className="ml-2 text-amber-200">
          {g.one_regime ? "· one market direction only" : `· ${g.expiries} expir${g.expiries === 1 ? "y" : "ies"}`} — too early to judge
        </span>
      )}
    </div>
  );
}
export type StructuresBoardData = {
  asOf: string | null;
  stance: string | null;
  stanceAsOf?: string | null;
  structures: StructureMeta[];
};

const HEADS: { label: string; tip: string; right?: boolean }[] = [
  { label: "Ticker", tip: "Stock and morning spot. Click a row to drive payoff + numbers above." },
  { label: "Trade", tip: "Legs: − = sell, + = buy · strike · P/C · expiry. Hover for bid/ask/fill." },
  { label: "Credit", right: true, tip: "Money per contract (×100) at a realistic fill (bid + 23 % of spread selling)." },
  { label: "Capital", right: true, tip: "Money tied up per contract (cash, margin, or max loss)." },
  { label: "Win", right: true, tip: "Chance the trade makes money at expiry from market IV." },
  { label: "Expected", right: true, tip: "Avg result ÷ capital if the stock moves like its last 2 years." },
  { label: "Bad case", right: true, tip: "Worst 1-in-20 outcome ÷ capital from the same history." },
  { label: "Why today", tip: "Rule that put this trade on the board today (IV/RV, regime)." },
];

const usd = (v: number | null | undefined) =>
  v == null ? "—" : `$${Math.abs(v * 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
const pct = (v: number | null | undefined, d = 0) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);

/** Drop repetitive edge-quintile tags painted on every short-premium row. */
export function cleanFitWhy(raw: string): string {
  return raw
    .replace(/,?\s*put edge Q\d+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/^,\s*|,\s*$/g, "")
    .trim();
}

function legText(l: StructureLeg): string {
  return `${l.qty > 0 ? "+" : "−"}${l.strike}${l.side === "put" ? "P" : "C"} ${formatMd(l.expiry)}`;
}

function accentLine(text: string): ReactNode {
  const parts = text.split(/(\d+(?:\.\d+)?×|\d+(?:\.\d+)?%|IV\/RV\s*\d+(?:\.\d+)?|sell puts|smaller puts|cut new put size)/gi);
  return parts.map((p, i) => {
    if (!p) return null;
    if (/^(sell puts|smaller puts|cut new put size)$/i.test(p)) {
      return <span key={i} className="font-semibold text-[#d4af37]">{p}</span>;
    }
    if (/^\d/.test(p) || /^IV\/RV/i.test(p)) {
      return <span key={i} className="font-mono font-semibold text-white">{p}</span>;
    }
    return <span key={i} className="text-amber-100">{p}</span>;
  });
}

function legsTip(r: StructurePick, asOf: string | null): string {
  const lines = r.legs.map(
    (l) =>
      `${l.qty > 0 ? "Buy" : "Sell"} ${l.strike}${l.side === "put" ? "P" : "C"} ${formatMd(l.expiry)} · bid $${l.bid.toFixed(2)} / ask $${l.ask.toFixed(2)} → fill $${l.px.toFixed(2)} · IV ${(l.iv * 100).toFixed(0)} %`,
  );
  return [...lines, "", `Morning scan ${asOf ? formatMd(asOf) : ""}. Fill = bid + 23 % of spread (sell).`].join("\n");
}

function capitalTip(id: string, r: StructurePick): string {
  if (id === "csp") return `Cash to buy 100 shares at ${r.legs[0]?.strike} = ${usd(r.capital)}.`;
  if (id === "covered_call" || id === "collar") return `100 shares ≈ ${usd(r.capital)}.`;
  if (id === "short_strangle" || id === "short_straddle") {
    return `Broker margin ≈ ${usd(r.capital)}. Undefined risk. Margin only.`;
  }
  return `Max loss ≈ ${usd(r.capital)} per contract.`;
}

function whyTip(r: StructurePick): string {
  const out = [`${r.dte} days to expiry.`, cleanFitWhy(r.fit_why) || r.fit_why];
  if (r.iv_rv != null) out.push(`IV/RV ${r.iv_rv.toFixed(2)}: implied ÷ 20-day realized. >1 rich (sell); <1 cheap (buy).`);
  return out.filter(Boolean).join("\n\n");
}

/** Board JSON from nightly/morning structures.py → option_score_snapshots. */
export function useStructuresBoard() {
  return useQuery({
    queryKey: ["options-structures"],
    queryFn: async (): Promise<StructuresBoardData> => {
      const r = await fetch("/api/options/structures", { credentials: "include" });
      if (!r.ok) throw new Error("structures fetch failed");
      return r.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 15 * 60_000,
    refetchOnWindowFocus: true,
  });
}

function LegsCell({ r, asOf }: { r: StructurePick; asOf: string | null }) {
  return (
    <DataTip tip={legsTip(r, asOf)}>
      <span className="inline-flex flex-wrap gap-0.5">
        {r.legs.map((l, i) => (
          <span
            key={`${l.strike}-${l.side}-${i}`}
            className={cn(
              "px-1 py-px rounded border font-mono text-[10px] tabular-nums leading-tight",
              l.qty < 0
                ? "border-emerald-500/35 bg-emerald-950/40 text-emerald-200"
                : "border-sky-500/35 bg-sky-950/40 text-sky-100",
            )}
          >
            {legText(l)}
          </span>
        ))}
      </span>
    </DataTip>
  );
}

function PicksBlock({
  title, tip, structureId, rows, asOf, selected, onSelect, startIdx = 0,
}: {
  title: string; tip: string; structureId: string; rows: StructurePick[]; asOf: string | null;
  selected?: string | null; onSelect?: (ticker: string) => void; startIdx?: number;
}) {
  if (!rows.length) return null;
  return (
    <div className="space-y-1 w-full min-w-0">
      <div className="text-[10px] font-semibold text-white tracking-wide">
        <DataTip tip={tip}>{title} ({rows.length})</DataTip>
      </div>
      <div className={cn(GRID_WRAP, "w-full min-w-0")}>
        <table className="w-full min-w-0 border-collapse">
          <thead>
            <tr className={GRID_HEADER}>
              {HEADS.map((h) => (
                <th key={h.label} className={cn(GRID_TH, "!py-1 !text-[9px]", h.right ? "text-right" : "text-left")}>
                  <DataTip tip={h.tip}>{h.label}</DataTip>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const on = selected === r.ticker;
              return (
                <tr
                  key={r.ticker}
                  className={cn(
                    gridRow(startIdx + i),
                    onSelect && "cursor-pointer",
                    on && "bg-[#d4af37]/15 ring-1 ring-inset ring-[#d4af37]/40",
                  )}
                  onClick={onSelect ? () => onSelect(r.ticker) : undefined}
                >
                  <td className={cn(GRID_TD, "font-mono !py-1")}>
                    <TickerLink ticker={r.ticker} returnLabel="Structures" />
                    <span className="text-amber-100 ml-1 text-[10px]">${r.spot.toFixed(0)}</span>
                  </td>
                  <td className={cn(GRID_TD, "!py-1")}>
                    <span className="inline-flex items-center gap-1">
                      <LegsCell r={r} asOf={asOf} />
                      <AddToTicket label="+" tip="Add this structure to the trade ticket at live bid/ask"
                        legs={r.legs.map((l) => ({ ticker: r.ticker, kind: l.side, side: l.qty > 0 ? "long" as const : "short" as const,
                          qty: Math.abs(l.qty), strike: l.strike, expiry: l.expiry }))} />
                    </span>
                  </td>
                  <td className={cn(GRID_TD, "text-right font-mono font-semibold !py-1", r.credit >= 0 ? "text-emerald-300" : "text-red-300")}>
                    <DataTip tip={r.credit >= 0 ? `Collect ${usd(r.credit)} now.` : `Pay ${usd(r.credit)} now.`}>
                      {r.credit >= 0 ? "+" : "−"}{usd(r.credit)}
                    </DataTip>
                  </td>
                  <td className={cn(GRID_TD, "text-right font-mono text-amber-50 !py-1")}>
                    <DataTip tip={capitalTip(structureId, r)}>{usd(r.capital)}</DataTip>
                  </td>
                  <td className={cn(GRID_TD, "text-right font-mono text-white !py-1")}>
                    <DataTip tip={`${pct(r.p_mkt)} profit chance at expiry from market IV.`}>{pct(r.p_mkt)}</DataTip>
                  </td>
                  <td className={cn(GRID_TD, "text-right font-mono font-bold !py-1", (r.ev_rv_cap ?? 0) >= 0 ? "text-emerald-300" : "text-red-300")}>
                    <DataTip tip={`2y-history avg ≈ ${pct(r.ev_rv_cap, 1)} of capital.`}>{pct(r.ev_rv_cap, 1)}</DataTip>
                  </td>
                  <td className={cn(GRID_TD, "text-right font-mono text-red-300 !py-1")}>
                    <DataTip tip={r.worst5 == null ? null : `1-in-20 loss ≈ ${pct(Math.abs(r.worst5), 0)} of capital.`}>
                      {pct(r.worst5, 0)}
                    </DataTip>
                  </td>
                  <td className={cn(GRID_TD, "text-[10px] leading-snug !py-1")}>
                    <DataTip tip={whyTip(r)}>
                      <span className="text-[#d4af37] font-mono mr-1">{r.dte}d</span>
                      {accentLine(cleanFitWhy(r.fit_why))}
                    </DataTip>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export const StructurePicksTable = memo(function StructurePicksTable({
  structureId,
  rows,
  asOf,
  selected,
  onSelect,
}: {
  structureId: string;
  rows: StructurePick[];
  asOf: string | null;
  selected?: string | null;
  onSelect?: (ticker: string) => void;
}) {
  if (!rows.length) {
    return (
      <div className="space-y-1">
        <TrackRecord structureId={structureId} />
        <p className="text-[11px] text-amber-100 px-1 py-1">
          No trade today — market doesn&apos;t match when this structure fits.
        </p>
      </div>
    );
  }
  const primary = rows.filter((r) => !r.tier || r.tier === "primary");
  const more = rows.filter((r) => r.tier === "more");
  const margin = rows.filter((r) => r.tier === "margin");
  const study = rows.filter((r) => r.tier === "study");
  return (
    <div className="space-y-2 w-full min-w-0">
      <TrackRecord structureId={structureId} />
      <PicksBlock
        title="Today"
        tip="Strict regime-fit · real Schwab fills · one ticker once · logged for grading."
        structureId={structureId} rows={primary}
        asOf={asOf} selected={selected} onSelect={onSelect}
      />
      <PicksBlock
        title="More (soft gate)"
        tip="Leftover names: positive EV + softer IV/RV (sell ≥1.05, buy ≤1.05) / CSP edge Q≥3. Not ledgered."
        structureId={structureId} rows={more} asOf={asOf} selected={selected} onSelect={onSelect}
        startIdx={primary.length}
      />
      <PicksBlock
        title="Margin alts"
        tip="Short strangle/straddle: S076 made money on margin but return÷risk below CSP. Margin account only · not ledgered."
        structureId={structureId} rows={margin} asOf={asOf} selected={selected} onSelect={onSelect}
        startIdx={primary.length + more.length}
      />
      <PicksBlock
        title="Study only"
        tip="S076 fail structures — priced with real fills so you can see the shape. Not a recommendation; not ledgered."
        structureId={structureId} rows={study} asOf={asOf} selected={selected} onSelect={onSelect}
        startIdx={primary.length + more.length + margin.length}
      />
    </div>
  );
});
