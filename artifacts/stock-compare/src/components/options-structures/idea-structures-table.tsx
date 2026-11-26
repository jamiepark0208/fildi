/** A419 — per-idea structure table: one row per candidate, best cell per lens from the payload. */
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";
import { formatMd } from "@/lib/format";
import { HEADS, TIER_LABEL, lensBest, pct, rowTip, sortCandidates, usd0, type IdeaContext } from "./idea-structures-model";

export function IdeaTable({ ctx }: { ctx: IdeaContext }) {
  const rows = useMemo(() => sortCandidates(ctx.candidates ?? []), [ctx.candidates]);
  const best = ctx.best ?? {};
  const notes = ctx.lens_notes ?? {};
  const tipOf = (h: (typeof HEADS)[number]) =>
    h.key === "cash" ? notes.cash ?? h.tip : h.key === "finite" ? notes.finite_loss ?? h.tip
      : h.key === "matched" || h.key === "matched_cash" ? notes.matched_downside ?? h.tip : h.tip;

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-x-auto bg-black">
      <table className="w-full min-w-[720px] border-collapse bg-black text-[11px]">
        <thead>
          <tr className={cn(GRID_HEADER, "bg-black")}>
            {HEADS.map((h) => (
              <th key={h.key} className={cn(GRID_TH, "!py-1 bg-black", h.right ? "text-right" : "text-left")}>
                <DataTip tip={tipOf(h)}>{h.label}</DataTip>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => {
            const dim = c.status === "model_limitation" || c.eligible === false;
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
                key={c.spec_hash ?? c.id}
                className={cn(gridRow(i), grey && "opacity-60", dim && "opacity-50")}
              >
                <td className={cn(GRID_TD, "!py-1 font-mono text-white")}>
                  <DataTip tip={rowTip(c)}>
                    <span className={dim ? "text-amber-200/80" : undefined}>
                      {c.id.replace(/_/g, " ")}{c.eligible === false ? " ✕" : ""}
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
                  {grey && fl?.why ? "—" : fl?.why ? (
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
                <td className={cn(GRID_TD, "!py-1 text-amber-100")}>{c.tier ? TIER_LABEL[c.tier] ?? c.tier : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
