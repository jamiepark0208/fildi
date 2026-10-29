/**
 * Live › Market conviction strip — Kalshi 15m + desk lean. Minimal one-liner.
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

type MarketContext = {
  asOf: string;
  btc15m: Fifteen | null;
  ndq15m: Fifteen | null;
  fomc: { dateLabel: string; holdPct: number; cutPct: number; hikePct: number } | null;
  cpi: { monthLabel: string; medianYoY: number } | null;
  deskLean: DeskLean | null;
  regimeAccuracy: {
    lookbackDays: number; n: number; correctPct: number | null; note: string;
    risk?: Partial<Record<"calm" | "normal" | "elevated" | "stormy", { n: number; pDrop: number }>>;
  } | null;
  kalshiNote: string;
};

function leanShort(lean: DeskLean["lean"]): string {
  if (lean === "bullish") return "bull";
  if (lean === "bearish") return "bear";
  if (lean === "mixed") return "mix";
  return "thin";
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
  const m15 = data.btc15m ?? data.ndq15m;
  const hasKalshi = !!(data.btc15m || data.ndq15m || data.fomc || data.cpi);
  if (!hasKalshi && !desk) return null;

  const conflict =
    desk &&
    desk.lean !== "thin" &&
    desk.lean !== "mixed" &&
    data.btc15m &&
    ((desk.lean === "bullish" && data.btc15m.upPct <= 45)
      || (desk.lean === "bearish" && data.btc15m.upPct >= 55));

  const parts: { key: string; text: string; className?: string; title?: string }[] = [];

  if (m15) {
    const up = m15.upPct >= 55;
    const down = m15.upPct <= 45;
    parts.push({
      key: "15m",
      text: `${m15.label} ${up ? "↑" : down ? "↓" : "~"}${m15.upPct}%`,
      className: up ? "text-emerald-400" : down ? "text-red-400" : "text-white",
      title: `${m15.marketTicker} · crowd odds`,
    });
  }
  if (data.fomc) {
    parts.push({
      key: "fomc",
      text: `FOMC ${data.fomc.dateLabel} hold ${data.fomc.holdPct}%`,
      className: "text-white",
      title: data.fomc.dateLabel,
    });
  }
  if (data.cpi) {
    parts.push({
      key: "cpi",
      text: `CPI ${data.cpi.monthLabel} ~${data.cpi.medianYoY}%`,
      className: "text-white",
      title: data.cpi.monthLabel,
    });
  }
  if (desk && desk.n > 0) {
    parts.push({
      key: "desk",
      text: `Desk ${leanShort(desk.lean)}`,
      className:
        desk.lean === "bullish" ? "text-emerald-400"
          : desk.lean === "bearish" ? "text-red-400"
            : "text-white",
      title: desk.note,
    });
  }
  if (conflict) {
    parts.push({ key: "⚠", text: "⚠", className: "text-amber-400", title: "Desk ≠ BTC 15m" });
  }

  // A179 trust: loud as-of + calendar hint (FOMC/CPI already above) + regime hit-rate.
  // No Options GO row here — Rankings / Live top-options owns that (plan review).
  const asOfDate = new Date(data.asOf);
  const asOfOk = Number.isFinite(asOfDate.getTime());
  const asOfLabel = asOfOk
    ? asOfDate.toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }) + " ET"
    : null;
  const etHour = asOfOk
    ? Number(asOfDate.toLocaleString("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }))
    : null;
  const sessionHint =
    etHour == null ? null
      : etHour < 9 || (etHour === 9 && Number(asOfDate.toLocaleString("en-US", { timeZone: "America/New_York", minute: "2-digit" })) < 30) ? "pre"
        : etHour >= 16 ? "closed"
          : "open";
  if (asOfLabel) {
    parts.push({
      key: "asof",
      text: sessionHint === "open" ? asOfLabel : `${asOfLabel} · ${sessionHint ?? "as-of"}`,
      className: sessionHint === "closed" || sessionHint === "pre" ? "text-amber-300" : "text-amber-100",
      title: data.kalshiNote || "Strip fetch time (ET)",
    });
  }
  const reg = data.regimeAccuracy;
  const calm = reg?.risk?.calm;
  const storm = reg?.risk?.stormy;
  if (calm && storm && calm.n + storm.n >= 8) {
    parts.push({
      key: "risk",
      text: `drop odds calm ${calm.pDrop}% · stormy ${storm.pDrop}%`,
      className: "text-white/80",
      title: `Live-graded rest-of-day risk call (SPY, ${reg.lookbackDays}d): share of checkpoints followed by a ≥ ½-day-range drop before the close. Backtest S126: calm 10%, stormy 33%. n calm ${calm.n}, stormy ${storm.n}.`,
    });
  }
  if (reg?.correctPct != null && reg.n >= 8) {
    parts.push({
      key: "reg",
      text: `dir ${reg.correctPct}% (no edge)`,
      className: "text-amber-100",
      title: reg.note,
    });
  }

  if (parts.length === 0) return null;

  return (
    <div
      className="rounded-md border border-cyan-400/25 bg-zinc-950 px-2 py-0.5 text-[10px] font-mono text-white truncate"
      title={data.kalshiNote}
    >
      {parts.map((p, i) => (
        <span key={p.key}>
          {i > 0 && <span className="text-amber-100/70"> · </span>}
          <span className={cn(p.className)} title={p.title}>{p.text}</span>
        </span>
      ))}
    </div>
  );
}
