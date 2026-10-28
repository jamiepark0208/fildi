/**
 * Jamie 10-28 (A290): sold-put delta band — GET/PUT /api/strategies/put-band.
 * Shared on Model List › sell puts header and Rankings › Rules.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { formatMdYy } from "@/lib/format";
import { queryKeys } from "@/lib/query-keys";
import {
  type PutBandPref,
  type PutBandState,
  PUT_BAND_TOOLTIP,
  parsePutBandError,
  putBandPrefLabel,
  putBandSegmentActive,
  putBandShiftSteps,
} from "@/lib/put-band-pref";

const SEGMENT_CLS =
  "px-1.5 py-0.5 rounded border text-[9px] font-semibold whitespace-nowrap transition-colors disabled:opacity-50";
const SEGMENT_ON = "border-[#d4af37] bg-[#d4af37]/15 text-white";
const SEGMENT_OFF = "border-zinc-600 bg-black/40 text-amber-100 hover:border-[#d4af37]/50";

async function fetchPutBand(): Promise<PutBandState> {
  const r = await fetch("/api/strategies/put-band", { credentials: "include" });
  if (!r.ok) throw new Error("put-band GET failed");
  const j = await r.json();
  return {
    pref: (j.pref ?? { mode: "auto" }) as PutBandPref,
    bands: Array.isArray(j.bands) ? j.bands : [],
    computedAt: j.computedAt ?? null,
    updatedAt: j.updatedAt ?? null,
  };
}

function invalidatePutSurfaces(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: ["put-band"] });
  void qc.invalidateQueries({ queryKey: ["watchlist-model"] });
  void qc.invalidateQueries({ queryKey: queryKeys.optionsRankings("put") });
  void qc.invalidateQueries({ queryKey: queryKeys.optionsRankingsLite("put") });
  void qc.invalidateQueries({ queryKey: ["put-ladder"] });
  void qc.invalidateQueries({
    predicate: (q) => q.queryKey[0] === "options-batch",
  });
}

export function PutBandSelector({ className }: { className?: string }) {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery({
    queryKey: ["put-band"],
    queryFn: fetchPutBand,
    staleTime: 30_000,
  });

  const mutation = useMutation({
    mutationFn: async (pref: PutBandPref) => {
      const r = await fetch("/api/strategies/put-band", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pref }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(parsePutBandError(body));
      return body as { pref: PutBandPref; rerun?: { ok: boolean; tail: string } };
    },
    onSuccess: (res) => {
      qc.setQueryData(["put-band"], (old: PutBandState | undefined) =>
        old
          ? { ...old, pref: res.pref, computedAt: old.computedAt }
          : { pref: res.pref, bands: [], computedAt: null },
      );
      invalidatePutSurfaces(qc);
      void fetchPutBand().then((fresh) => {
        qc.setQueryData(["put-band"], fresh);
      });
    },
  });

  const busy = mutation.isPending;
  const pref = data?.pref ?? { mode: "auto" as const };
  const rerunWarn =
    mutation.isError
      ? mutation.error.message
      : mutation.data?.rerun?.ok === false
        ? mutation.data.rerun.tail
        : null;

  const setPref = (next: PutBandPref) => {
    if (busy) return;
    mutation.mutate(next);
  };

  if (isLoading) {
    return (
      <div className={cn("flex items-center gap-1 text-[9px] text-amber-200/60", className)} data-testid="put-band-selector">
        <Loader2 className="w-3 h-3 animate-spin" />
        Put band…
      </div>
    );
  }
  if (isError) {
    return (
      <p className={cn("text-[9px] text-red-400", className)} data-testid="put-band-selector">
        Put band unavailable
      </p>
    );
  }

  const computedLabel = data?.computedAt ? formatMdYy(data.computedAt) : "—";

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-1.5 gap-y-1 min-w-0 border border-[#d4af37]/20 bg-black/50 px-1.5 py-1",
        className,
      )}
      data-testid="put-band-selector"
    >
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <span className="text-[9px] font-bold uppercase tracking-wide text-[#d4af37] cursor-help shrink-0">
            Put Δ band
          </span>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="max-w-[320px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug"
        >
          {PUT_BAND_TOOLTIP}
        </TooltipContent>
      </Tooltip>

      <div className="flex flex-wrap items-center gap-0.5 min-w-0">
        <button
          type="button"
          disabled={busy}
          className={cn(SEGMENT_CLS, putBandSegmentActive(pref, "auto") ? SEGMENT_ON : SEGMENT_OFF)}
          onClick={() => setPref({ mode: "auto" })}
        >
          Auto (engine)
        </button>
        {putBandShiftSteps().map((steps) => (
          <button
            key={steps}
            type="button"
            disabled={busy}
            className={cn(SEGMENT_CLS, putBandSegmentActive(pref, steps) ? SEGMENT_ON : SEGMENT_OFF)}
            onClick={() => setPref({ mode: "shift", steps })}
          >
            {steps < 0 ? `Farther ${steps}` : `+${steps} Closer`}
          </button>
        ))}
        <span className={cn(SEGMENT_CLS, "inline-flex items-center gap-0.5 pr-0.5", pref.mode === "fixed" ? SEGMENT_ON : SEGMENT_OFF)}>
          <span className="text-[8px] uppercase text-amber-200/80">Fixed</span>
          <select
            aria-label="Fixed delta band"
            disabled={busy}
            className="max-w-[5.5rem] truncate rounded border border-zinc-600 bg-zinc-950 px-0.5 py-0 text-[9px] text-white"
            value={pref.mode === "fixed" ? pref.band : ""}
            onChange={(e) => {
              const band = e.target.value;
              if (band) setPref({ mode: "fixed", band });
            }}
          >
            <option value="" disabled>▾</option>
            {(data?.bands ?? []).map((b) => (
              <option key={b} value={b}>{b}Δ</option>
            ))}
          </select>
        </span>
        {busy && <Loader2 className="w-3 h-3 animate-spin text-amber-200/70 shrink-0" />}
      </div>

      <span className="text-[9px] text-amber-100/90 tabular-nums shrink-0">
        {putBandPrefLabel(pref)}
        <span className="text-amber-200/50"> · recs {computedLabel}</span>
      </span>

      {rerunWarn ? (
        <span className="text-[9px] text-amber-400 max-w-[280px] truncate" title={rerunWarn}>
          {rerunWarn}
        </span>
      ) : null}
    </div>
  );
}
