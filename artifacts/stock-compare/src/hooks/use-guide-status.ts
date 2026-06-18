import { useQueries } from "@tanstack/react-query";
import type { CoverageDomain } from "@/lib/scorecard-guide-metadata";

type TickerStatus = { ticker: string; lastFetched: string | null; coveragePct: number | null };
type FundStatus = { tickers: TickerStatus[]; apiBudget?: { remaining: number } };
type TechStatus = { tickers: TickerStatus[] };
type SdmStatus = { sources: { name: string; isActive: boolean; callsRemaining?: number }[] };

export type CoverageTone = "good" | "partial" | "unknown";

export type GuideStatusChips = {
  lastRefresh: string;
  coverage: { label: string; tone: CoverageTone };
  sources: Array<{ name: string; active: boolean; detail?: string }>;
  stale?: boolean;
  peerRanked?: boolean;
};

function coverageTone(pct: number | null): CoverageTone {
  if (pct == null) return "unknown";
  return pct >= 80 ? "good" : "partial";
}

function avgCoverage(tickers: TickerStatus[]): number | null {
  const vals = tickers.map(t => t.coveragePct).filter((v): v is number => v != null);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

function latestFetch(tickers: TickerStatus[]): Date | null {
  const dates = tickers.map(t => t.lastFetched).filter(Boolean).map(d => new Date(d!));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map(d => d.getTime())));
}

function fmtDate(d: Date | null): string {
  if (!d || Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function isStale(d: Date | null, maxDays: number): boolean {
  if (!d) return true;
  return (Date.now() - d.getTime()) / 864e5 > maxDays;
}

export function useGuideStatus() {
  const results = useQueries({
    queries: [
      { queryKey: ["guide", "fundamentals-status"], queryFn: () => fetch("/api/fundamentals/status").then(r => r.json()) as Promise<FundStatus>, staleTime: 60_000 },
      { queryKey: ["guide", "technicals-status"], queryFn: () => fetch("/api/technicals/status").then(r => r.json()) as Promise<TechStatus>, staleTime: 60_000 },
      { queryKey: ["guide", "sdm-status"], queryFn: () => fetch("/api/sdm/status").then(r => r.json()) as Promise<SdmStatus>, staleTime: 60_000 },
    ],
  });

  const fund = results[0].data;
  const tech = results[1].data;
  const sdm = results[2].data;

  const fundCov = fund ? avgCoverage(fund.tickers) : null;
  const techCov = tech ? avgCoverage(tech.tickers) : null;
  const fundAt = latestFetch(fund?.tickers ?? []);
  const techAt = latestFetch(tech?.tickers ?? []);

  const sourceActive = (name: string) => sdm?.sources.some(s => s.name === name && s.isActive) ?? false;
  const fmpRemaining = fund?.apiBudget?.remaining;

  const fundStale = isStale(fundAt, 7);
  const techStale = isStale(techAt, 1);

  const coverageFor = (domain: CoverageDomain): { pct: number | null; label: string; tone: CoverageTone } => {
    if (domain === "fundamentals") {
      const pct = fundCov;
      return {
        pct,
        tone: coverageTone(pct),
        label: pct == null ? "—" : pct >= 80 ? `${pct}% complete` : `Partial (${pct}%)`,
      };
    }
    if (domain === "technicals") {
      const pct = techCov;
      return {
        pct,
        tone: coverageTone(pct),
        label: pct == null ? "—" : pct >= 80 ? `${pct}% complete` : `Partial (${pct}%)`,
      };
    }
    return { pct: null, tone: "unknown", label: "On scan" };
  };

  const stripFor = (domain: CoverageDomain): string => {
    if (domain === "fundamentals") {
      return `Last refresh: ${fmtDate(fundAt)} · Coverage: ${coverageFor("fundamentals").label} · FactSet: ${sourceActive("factset") ? "Active" : "Inactive"} · FMP: ${sourceActive("fmp") ? "Active" : "Inactive"}${fmpRemaining != null ? ` (${fmpRemaining} calls left)` : ""}${fundStale ? " · Stale" : ""}`;
    }
    if (domain === "technicals") {
      return `Last refresh: ${fmtDate(techAt)} · Coverage: ${coverageFor("technicals").label} · Yahoo/DB: Active${techStale ? " · Stale" : ""}`;
    }
    return `Chain: live at scan · Stock inputs: daily/weekly DB · Yahoo: Active`;
  };

  const chipsFor = (domain: CoverageDomain): GuideStatusChips => {
    if (domain === "fundamentals") {
      const cov = coverageFor("fundamentals");
      return {
        lastRefresh: fmtDate(fundAt),
        coverage: { label: cov.label, tone: coverageTone(cov.pct) },
        sources: [
          { name: "FactSet", active: sourceActive("factset") },
          {
            name: "FMP",
            active: sourceActive("fmp"),
            detail: fmpRemaining != null ? `${fmpRemaining} calls left` : undefined,
          },
        ],
        stale: fundStale,
      };
    }
    if (domain === "technicals") {
      const cov = coverageFor("technicals");
      return {
        lastRefresh: fmtDate(techAt),
        coverage: { label: cov.label, tone: coverageTone(cov.pct) },
        sources: [{ name: "Yahoo/DB", active: true }],
        stale: techStale,
      };
    }
    return {
      lastRefresh: "Live at scan",
      coverage: { label: "On scan", tone: "unknown" },
      sources: [
        { name: "Chain", active: true, detail: "live at scan" },
        { name: "Stock inputs", active: true, detail: "daily/weekly DB" },
        { name: "Yahoo", active: true },
      ],
    };
  };

  const headerChips = (): GuideStatusChips => ({
    peerRanked: true,
    lastRefresh: "",
    coverage: { label: "", tone: "unknown" },
    sources: [
      { name: "FactSet", active: sourceActive("factset") },
      {
        name: "FMP",
        active: sourceActive("fmp"),
        detail: fmpRemaining != null ? `${fmpRemaining} calls left` : undefined,
      },
    ],
  });

  /** Dynamic suffix appended to static Notes when live data shows deficiency */
  const noteSuffix = (domain: CoverageDomain): string => {
    const parts: string[] = [];
    if (domain === "fundamentals") {
      if (fundCov != null && fundCov < 80) parts.push("Partial: some tickers missing fields");
      if (fundStale) parts.push("Stale: refresh overdue");
      if (!sourceActive("factset") && !sourceActive("fmp")) parts.push("Primary sources inactive");
    }
    if (domain === "technicals") {
      if (techCov != null && techCov < 80) parts.push("Partial: some tickers missing fields");
      if (techStale) parts.push("Stale: refresh overdue");
    }
    return parts.length ? ` · ${parts.join("; ")}` : "";
  };

  return {
    loading: results.some(q => q.isLoading),
    coverageFor,
    stripFor,
    chipsFor,
    headerChips,
    noteSuffix,
    fundStale,
    techStale,
    fmpRemaining,
    sources: { factset: sourceActive("factset"), fmp: sourceActive("fmp") },
  };
}
