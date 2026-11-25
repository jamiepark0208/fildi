/**
 * A418 / A192 V5 — one idea, every structure on shared scenarios (server lenses only).
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
import { formatMd } from "@/lib/format";
import { simpleOf } from "./structure-themes";

type LensCash = { ret?: number | null; per_share?: number; why?: string };
type LensFinite = { ret?: number | null; max_loss?: number; why?: string };
type LensMatched = { ret?: number | null; ev_usd?: number; cash_usd?: number; units?: number; why?: string };
type IdeaCandidate = {
  id: string;
  kind: "baseline" | "structure";
  expiry?: string | null;
  tier?: string | null;
  status?: string;
  fit?: boolean;
  lenses?: {
    p_win?: number | null;
    cash?: LensCash;
    finite_loss?: LensFinite;
    matched_downside?: LensMatched;
  };
};

type IdeaContext = {
  status?: string;
  reason?: string;
  read?: string;
  lenses_agree?: boolean;
  best?: { cash?: string; finite_loss?: string; matched_downside?: string };
  candidates?: IdeaCandidate[];
  capability_limits?: string[];
  dist?: { p05?: number; p50?: number; p95?: number };
  n_eff?: number;
  n_paths?: number;
};

type IdeaResponse = { asOf: string; context: IdeaContext };

const pct = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(d)}%`;
const usd0 = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `$${Math.round(v).toLocaleString()}`;

const BASELINE_ORDER = ["no_trade", "cash", "stock"] as const;

const HEADS: { key: string; label: string; tip: string; right?: boolean }[] = [
  { key: "structure", label: "Structure", tip: "Baseline or structure id — same 2y paths for every row." },
  { key: "expiry", label: "Expiry", tip: "Nearest leg expiry used for horizon marks." },
  { key: "cash", label: "Cash ret", right: true, tip: "Expected return ÷ cash tied up (per share basis on baselines)." },
  { key: "finite", label: "Max-loss ret", right: true, tip: "EV ÷ max loss when finite; otherwise why." },
  { key: "matched", label: "Matched $ EV", right: true, tip: "Units sized so worst 5% mean loss = $1,000 — expected P&L in dollars." },
  { key: "matched_cash", label: "Cash need", right: true, tip: "Capital required for the matched-downside size." },
  { key: "win", label: "Win %", right: true, tip: "Share of paths with positive total P&L at horizon." },
  { key: "tier", label: "Tier", tip: "Board tier when this structure was priced today." },
];

function useIdeaStructures(ticker: string | null) {
  return useQuery({
    queryKey: ["options-structures-idea", ticker],
    queryFn: async (): Promise<IdeaResponse | { missing: true }> => {
      const r = await fetch(`/api/options/structures/idea/${ticker}`, { credentials: "include" });
      if (r.status === 404) return { missing: true };
      if (!r.ok) throw new Error("idea structures fetch failed");
      return r.json();
    },
    enabled: !!ticker,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });
}

function sortCandidates(rows: IdeaCandidate[]): IdeaCandidate[] {
  const baselines = BASELINE_ORDER.map((id) => rows.find((r) => r.id === id)).filter(Boolean) as IdeaCandidate[];
  const rest = rows.filter((r) => r.kind !== "baseline").sort((a, b) => a.id.localeCompare(b.id));
  return [...baselines, ...rest];
}

function lensBest(id: string, best: IdeaContext["best"], lens: "cash" | "finite_loss" | "matched_downside") {
  return best?.[lens] === id;
}

function rowTip(c: IdeaCandidate): string | undefined {
  if (c.status === "model_limitation") {
    return "Model limitation — payoff shown for context; not ranked against other structures.";
  }
  return simpleOf(c.id);
}

function IdeaTable({ ctx }: { ctx: IdeaContext }) {
  const rows = useMemo(() => sortCandidates(ctx.candidates ?? []), [ctx.candidates]);
  const best = ctx.best ?? {};

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-x-auto bg-black">
      <table className="w-full min-w-[720px] border-collapse bg-black text-[11px]">
        <thead>
          <tr className={cn(GRID_HEADER, "bg-black")}>
            {HEADS.map((h) => (
              <th key={h.key} className={cn(GRID_TH, "!py-1 bg-black", h.right ? "text-right" : "text-left")}>
                <DataTip tip={h.tip}>{h.label}</DataTip>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => {
            const dim = c.status === "model_limitation";
            const grey = c.kind === "baseline";
            const L = c.lenses ?? {};
            const md = L.matched_downside;
            const fl = L.finite_loss;
            const cash = L.cash;
            const hiCash = lensBest(c.id, best, "cash");
            const hiFl = lensBest(c.id, best, "finite_loss");
            const hiMd = lensBest(c.id, best, "matched_downside");
            const cellHi = (on: boolean) => (on ? "ring-1 ring-inset ring-[#d4af37]/55 bg-[#d4af37]/10" : "");
            return (
              <tr
                key={c.id}
                className={cn(gridRow(i), grey && "opacity-60", dim && "opacity-50")}
              >
                <td className={cn(GRID_TD, "!py-1 font-mono text-white")}>
                  <DataTip tip={rowTip(c)}>
                    <span className={dim ? "text-amber-200/80" : undefined}>
                      {c.kind === "baseline" ? c.id.replace(/_/g, " ") : c.id.replace(/_/g, " ")}
                    </span>
                  </DataTip>
                </td>
                <td className={cn(GRID_TD, "!py-1 text-amber-100")}>
                  {c.expiry ? formatMd(c.expiry) : "—"}
                </td>
                <td className={cn(GRID_TD, "!py-1 text-right font-mono", cellHi(hiCash))}>
                  {cash?.why ? (
                    <span className="text-amber-200/70">{cash.why}</span>
                  ) : (
                    pct(cash?.ret)
                  )}
                </td>
                <td className={cn(GRID_TD, "!py-1 text-right font-mono", cellHi(hiFl))}>
                  {fl?.why ? (
                    <span className="text-amber-200/70">{fl.why}</span>
                  ) : (
                    pct(fl?.ret)
                  )}
                </td>
                <td className={cn(GRID_TD, "!py-1 text-right font-mono", cellHi(hiMd))}>
                  {md?.why ? <span className="text-amber-200/70">—</span> : usd0(md?.ev_usd)}
                </td>
                <td className={cn(GRID_TD, "!py-1 text-right font-mono", cellHi(hiMd))}>
                  {md?.why ? <span className="text-amber-200/70">—</span> : usd0(md?.cash_usd)}
                </td>
                <td className={cn(GRID_TD, "!py-1 text-right font-mono text-white")}>{pct(L.p_win, 0)}</td>
                <td className={cn(GRID_TD, "!py-1 text-amber-100")}>{c.tier ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function IdeaStructuresPanel({ ticker, onClose }: { ticker: string | null; onClose: () => void }) {
  const { data, isLoading, isError } = useIdeaStructures(ticker);
  const open = !!ticker;

  const body = (() => {
    if (isLoading) {
      return <p className="text-[11px] text-amber-200/70 px-1 animate-pulse">Loading shared scenario comparison…</p>;
    }
    if (isError) {
      return <p className="text-[11px] text-red-300 px-1">Could not load structure comparison.</p>;
    }
    if (data && "missing" in data) {
      return <p className="text-[11px] text-amber-100 px-1">No structure comparison today.</p>;
    }
    const ctx = (data as IdeaResponse | undefined)?.context;
    if (!ctx) {
      return <p className="text-[11px] text-amber-100 px-1">No structure comparison today.</p>;
    }
    if (ctx.status === "context_unavailable") {
      return (
        <p className="text-[11px] text-amber-100 px-1">
          {ctx.reason ?? "Structure context unavailable for this name today."}
        </p>
      );
    }
    const footerTip = [
      ...(ctx.capability_limits ?? []),
      ctx.dist
        ? `Path return dist (per share): p05 ${pct(ctx.dist.p05, 1)} · p50 ${pct(ctx.dist.p50, 1)} · p95 ${pct(ctx.dist.p95, 1)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");

    return (
      <div className="space-y-2">
        {ctx.read ? (
          <p className="text-[11px] text-[#d4af37] px-1 leading-snug">{ctx.read}</p>
        ) : null}
        <IdeaTable ctx={ctx} />
        <DataTip tip={footerTip}>
          <p className="text-[10px] text-amber-200/60 px-1 cursor-default">
            No directional view — 2 y history paths, n_eff {ctx.n_eff ?? "—"}
          </p>
        </DataTip>
      </div>
    );
  })();

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto bg-zinc-950 border-[#d4af37]/30">
        <DialogHeader>
          <DialogTitle className="text-[#d4af37] font-mono">
            Structures for this idea — {ticker}
          </DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}