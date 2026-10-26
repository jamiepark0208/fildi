/**
 * Live › Market conviction strip — Kalshi 15m + desk lean + regime grade hit-rate.
 * One coalesced /live/market-context fetch (45s server cache). Display only.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

type Fifteen = {
  label: string;
  upPct: number;
  downPct: number;
  closesAt: string | null;
  marketTicker: string;
};

type DeskLean = {
  lean: "bullish" | "bearish" | "mixed" | "thin";
  n: number;
  avgDir: number;
  bullN: number;
  bearN: number;
  note: string;
};

type Accuracy = {
  lookbackDays: number;
  n: number;
  correct: number;
  incorrect: number;
  correctPct: number | null;
  note: string;
};

type MarketContext = {
  asOf: string;
  btc15m: Fifteen | null;
  ndq15m: Fifteen | null;
  fomc: { dateLabel: string; holdPct: number; cutPct: number; hikePct: number } | null;
  cpi: { monthLabel: string; medianYoY: number } | null;
  deskLean: DeskLean | null;
  regimeAccuracy: Accuracy | null;
  kalshiNote: string;
};

function FifteenChip({ m }: { m: Fifteen }) {
  const up = m.upPct >= 55;
  const down = m.upPct <= 45;
  const closes = m.closesAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Los_Angeles",
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(m.closesAt))
    : null;
  return (
    <span
      className={cn(
        "shrink-0 tabular-nums",
        up ? "text-emerald-400" : down ? "text-red-400" : "text-amber-100/85",
      )}
      title={`${m.marketTicker} · closes ${m.closesAt ?? "?"} · crowd odds, not FILDI forecast`}
    >
      {m.label} 15m {up ? "↑" : down ? "↓" : "~"}{m.upPct}%
      {closes ? <span className="text-white/50"> · {closes}</span> : null}
    </span>
  );
}

export function MarketContextStrip() {
  const { data } = useQuery({
    queryKey: ["live-market-context"],
    queryFn: async (): Promise<MarketContext> => {
      const r = await fetch("/api/live/market-context", { credentials: "include" });
      if (!r.ok) throw new Error("market-context failed");
      return r.json();
    },
    staleTime: 30_000,
    refetchInterval: 45_000,
    refetchOnWindowFocus: false,
  });

  if (!data) return null;

  const desk = data.deskLean;
  const acc = data.regimeAccuracy;
  const hasKalshi = !!(data.btc15m || data.ndq15m || data.fomc || data.cpi);
  if (!hasKalshi && !desk && !acc) return null;

  const deskClass =
    desk?.lean === "bullish" ? "text-emerald-400"
      : desk?.lean === "bearish" ? "text-red-400"
        : "text-amber-100/80";

  const conflict =
    desk &&
    desk.lean !== "thin" &&
    desk.lean !== "mixed" &&
    data.btc15m &&
    ((desk.lean === "bullish" && data.btc15m.upPct <= 45)
      || (desk.lean === "bearish" && data.btc15m.upPct >= 55));

  return (
    <div
      className="rounded-md border border-cyan-400/25 bg-zinc-950 px-2 py-1 flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 text-[10px] font-mono"
      title={data.kalshiNote}
    >
      <span className="text-cyan-400/80 shrink-0 font-semibold uppercase tracking-wide">Context</span>
      {data.btc15m && <FifteenChip m={data.btc15m} />}
      {data.ndq15m && <FifteenChip m={data.ndq15m} />}
      {data.fomc && (
        <span className="text-cyan-100/85 shrink-0" title="Kalshi FOMC">
          FOMC {data.fomc.dateLabel}: hold {data.fomc.holdPct}%
        </span>
      )}
      {data.cpi && (
        <span className="text-cyan-100/85 shrink-0" title="Kalshi CPI">
          CPI {data.cpi.monthLabel}: ~{data.cpi.medianYoY}%
        </span>
      )}
      {desk && desk.n > 0 && (
        <span className={cn("shrink-0", deskClass)} title={desk.note}>
          Desk {desk.lean}
          <span className="text-white/45"> · n={desk.n}</span>
        </span>
      )}
      {acc && (
        <span
          className={cn(
            "shrink-0",
            acc.correctPct == null ? "text-white/50"
              : acc.correctPct >= 55 ? "text-emerald-400/90"
                : acc.correctPct <= 45 ? "text-red-400/90"
                  : "text-amber-100/75",
          )}
          title={acc.note}
        >
          Regime hit {acc.correctPct != null ? `${acc.correctPct}%` : "—"}
          <span className="text-white/45"> · n={acc.n}/{acc.lookbackDays}d</span>
        </span>
      )}
      {conflict && (
        <span className="text-amber-400 shrink-0 font-semibold" title="Desk lean vs BTC 15m disagree">
          ⚠ desk≠BTC15m
        </span>
      )}
    </div>
  );
}
