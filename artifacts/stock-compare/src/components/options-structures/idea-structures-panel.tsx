/**
 * A419 / A192 V5 — one idea, every structure on shared scenarios (server lenses only).
 */
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTip } from "@/components/data-tip";
import { formatMd } from "@/lib/format";
import { LENS_LABEL, pct, useIdeaStructures, type IdeaResponse } from "./idea-structures-model";
import { IdeaTable } from "./idea-structures-table";

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
    const hypo = Object.entries(ctx.hypothetical_leaders ?? {});
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
        {ctx.read ? <p className="text-[11px] text-[#d4af37] px-1 leading-snug">{ctx.read}</p> : null}
        {hypo.length ? (
          <p className="text-[10px] text-amber-200/70 px-1">
            Would lead but fail their check (✕): {hypo.map(([l, id]) => `${id.replace(/_/g, " ")} (${LENS_LABEL[l] ?? l})`).join(" · ")}
          </p>
        ) : null}
        {ctx.decision_at ? (
          <p className="text-[10px] text-amber-200/60 px-1">
            Priced {formatMd(ctx.decision_at)} · held to {ctx.holding_horizon_at ? formatMd(ctx.holding_horizon_at) : "—"}
          </p>
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
