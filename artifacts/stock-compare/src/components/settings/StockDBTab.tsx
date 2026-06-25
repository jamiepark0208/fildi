import { useQuery } from "@tanstack/react-query";
import { Loader2, AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface FundamentalsRow {
  ticker: string;
  fundamentalsLastFetched: string | null;
  lastSource: string | null;
  fmpCoveragePercent: string | null;
  discrepancyFlags: string | null;
  // VALUE
  peRatio: string | null; pegRatio: string | null; forwardPe: string | null;
  priceToBook: string | null; priceToSales: string | null; evEbitda: string | null;
  evRevenue: string | null; dividendYield: string | null;
  // GROWTH
  revenueGrowthYoY: string | null; revenueGrowthYoyPrior: string | null;
  epsGrowth: string | null; analystTargetPrice: string | null;
  // QUALITY
  grossMargin: string | null; operatingMargin: string | null; netMargin: string | null;
  returnOnEquity: string | null; returnOnAssets: string | null;
  roic: string | null; wacc: string | null;
  // SAFETY / RAW
  freeCashFlow: string | null; totalRevenue: string | null; netIncome: string | null;
  ebitda: string | null; ebit: string | null; interestExpense: string | null;
  cashAndEquivalents: string | null; quarterlyOperatingCashFlow: string | null;
  totalDebt: string | null; totalStockholdersEquity: string | null;
  currentRatio: string | null; debtToEquity: string | null;
  sharesOutstanding: string | null; sharesOutstandingPrior: string | null;
  beta: string | null; effectiveTaxRate: string | null;
}

interface StockDBEntry {
  ticker: string;
  isWatchlist: boolean;
  peerGroupId: string | null;
  fundamentals: FundamentalsRow | null;
}

// ── Column definitions ────────────────────────────────────────────────────────

type FmtType = "pct" | "ratio" | "dollars" | "price" | "shares";

interface ColDef {
  key: keyof FundamentalsRow;
  label: string;
  family: "value" | "growth" | "quality" | "safety" | "meta";
  fmt: FmtType;
  // returns true if the value is suspect (not null, but looks wrong)
  suspect?: (v: number) => boolean;
}

const COLS: ColDef[] = [
  // VALUE
  { key: "peRatio",             label: "P/E",        family: "value",   fmt: "ratio",  suspect: v => v < 0 || v > 500 },
  { key: "pegRatio",            label: "PEG",        family: "value",   fmt: "ratio",  suspect: v => v < 0 || v > 100 },
  { key: "forwardPe",           label: "Fwd P/E",    family: "value",   fmt: "ratio",  suspect: v => v < 0 || v > 500 },
  { key: "priceToBook",         label: "P/B",        family: "value",   fmt: "ratio",  suspect: v => v < 0 || v > 100 },
  { key: "priceToSales",        label: "P/S",        family: "value",   fmt: "ratio",  suspect: v => v < 0 || v > 100 },
  { key: "evEbitda",            label: "EV/EBITDA",  family: "value",   fmt: "ratio",  suspect: v => v < -50 || v > 200 },
  { key: "evRevenue",           label: "EV/Rev",     family: "value",   fmt: "ratio",  suspect: v => v < 0 || v > 100 },
  { key: "dividendYield",       label: "Div Yield",  family: "value",   fmt: "pct",    suspect: v => v < 0 || v > 0.3 },
  // GROWTH
  { key: "revenueGrowthYoY",    label: "Rev Growth", family: "growth",  fmt: "pct",    suspect: v => v > 5 || v < -0.9 },
  { key: "revenueGrowthYoyPrior",label:"Rev Gro Pr", family: "growth",  fmt: "pct",    suspect: v => v > 5 || v < -0.9 },
  { key: "epsGrowth",           label: "EPS Growth", family: "growth",  fmt: "pct",    suspect: v => v > 10 || v < -0.9 },
  { key: "analystTargetPrice",  label: "Analyst TP", family: "growth",  fmt: "price",  suspect: v => v <= 0 },
  // QUALITY
  { key: "grossMargin",         label: "Gross Mgn",  family: "quality", fmt: "pct",    suspect: v => v > 1.0 || v < -1.0 },
  { key: "operatingMargin",     label: "Op Margin",  family: "quality", fmt: "pct",    suspect: v => v > 1.0 || v < -2.0 },
  { key: "netMargin",           label: "Net Margin", family: "quality", fmt: "pct",    suspect: v => v > 1.0 || v < -5.0 },
  { key: "returnOnEquity",      label: "ROE",        family: "quality", fmt: "pct",    suspect: v => v > 10 || v < -10 },
  { key: "returnOnAssets",      label: "ROA",        family: "quality", fmt: "pct",    suspect: v => v > 2 || v < -2 },
  { key: "roic",                label: "ROIC",       family: "quality", fmt: "pct",    suspect: v => v > 5 || v < -2 },
  { key: "wacc",                label: "WACC",       family: "quality", fmt: "pct",    suspect: v => v <= 0 || v > 0.5 },
  // SAFETY
  { key: "currentRatio",        label: "Curr Ratio", family: "safety",  fmt: "ratio",  suspect: v => v <= 0 },
  { key: "debtToEquity",        label: "D/E",        family: "safety",  fmt: "ratio",  suspect: v => v < 0 || v > 20 },
  { key: "ebitda",              label: "EBITDA",     family: "safety",  fmt: "dollars" },
  { key: "ebit",                label: "EBIT",       family: "safety",  fmt: "dollars" },
  { key: "interestExpense",     label: "Int Exp",    family: "safety",  fmt: "dollars", suspect: v => v < 0 },
  { key: "totalDebt",           label: "Total Debt", family: "safety",  fmt: "dollars" },
  { key: "cashAndEquivalents",  label: "Cash",       family: "safety",  fmt: "dollars" },
  { key: "quarterlyOCF",        label: "Qtrly OCF",  family: "safety",  fmt: "dollars" } as unknown as ColDef,
  // RAW INPUTS
  { key: "freeCashFlow",        label: "FCF",        family: "safety",  fmt: "dollars" },
  { key: "totalRevenue",        label: "Revenue",    family: "safety",  fmt: "dollars" },
  { key: "netIncome",           label: "Net Income", family: "safety",  fmt: "dollars" },
  { key: "totalStockholdersEquity", label: "Equity", family: "safety",  fmt: "dollars" },
  { key: "sharesOutstanding",   label: "Shares",     family: "meta",    fmt: "shares" },
  { key: "sharesOutstandingPrior",label:"Shares Pr", family: "meta",    fmt: "shares" },
  { key: "beta",                label: "Beta",       family: "meta",    fmt: "ratio",  suspect: v => v > 5 || v < -2 },
  { key: "effectiveTaxRate",    label: "Tax Rate",   family: "meta",    fmt: "pct",    suspect: v => v < 0 || v > 0.7 },
];

// Fix the OCF key
(COLS.find(c => c.label === "Qtrly OCF") as ColDef).key = "quarterlyOperatingCashFlow" as keyof FundamentalsRow;

const FAMILY_COLORS: Record<string, string> = {
  value:   "text-blue-400",
  growth:  "text-green-400",
  quality: "text-purple-400",
  safety:  "text-amber-400",
  meta:    "text-muted-foreground",
};

// ── Formatting ────────────────────────────────────────────────────────────────

function fmt(raw: string | null, type: FmtType): string {
  if (raw == null) return "—";
  const v = parseFloat(raw);
  if (!isFinite(v)) return "—";
  switch (type) {
    case "pct":    return `${(v * 100).toFixed(1)}%`;
    case "ratio":  return v.toFixed(2);
    case "price":  return `$${v.toFixed(2)}`;
    case "shares": return v >= 1e9 ? `${(v/1e9).toFixed(2)}B` : v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v.toFixed(0);
    case "dollars":
      const abs = Math.abs(v);
      const sign = v < 0 ? "−" : "";
      if (abs >= 1e12) return `${sign}$${(abs/1e12).toFixed(2)}T`;
      if (abs >= 1e9)  return `${sign}$${(abs/1e9).toFixed(2)}B`;
      if (abs >= 1e6)  return `${sign}$${(abs/1e6).toFixed(1)}M`;
      return `${sign}$${abs.toFixed(0)}`;
  }
}

function isSuspect(col: ColDef, raw: string | null): boolean {
  if (!col.suspect || raw == null) return false;
  const v = parseFloat(raw);
  return isFinite(v) && col.suspect(v);
}

function fmtDate(ts: string | null): string {
  if (!ts) return "never";
  const d = new Date(ts);
  const now = Date.now();
  const diff = now - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30)  return `${days}d ago`;
  return d.toLocaleDateString();
}

// ── Main component ────────────────────────────────────────────────────────────

export function StockDBTab() {
  const { data, isLoading, isError, refetch, isFetching } = useQuery<StockDBEntry[]>({
    queryKey: ["admin-stock-db"],
    queryFn: async () => {
      const r = await fetch("/api/fundamentals/stock-db");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) return (
    <div className="flex items-center justify-center h-48">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );

  if (isError || !data) return (
    <div className="flex flex-col items-center gap-3 h-48 justify-center text-sm text-muted-foreground">
      <AlertTriangle className="h-6 w-6 text-red-400" />
      Failed to load stock DB.
      <button onClick={() => refetch()} className="text-xs px-3 py-1 border border-border rounded hover:bg-secondary">Retry</button>
    </div>
  );

  const nullCount  = data.reduce((acc, row) => acc + COLS.filter(c => row.fundamentals?.[c.key] == null).length, 0);
  const totalCells = data.length * COLS.length;
  const coverage   = totalCells > 0 ? Math.round((1 - nullCount / totalCells) * 100) : 0;
  const noRow      = data.filter(d => !d.fundamentals).length;

  // Group columns by family for header display
  const families = ["value", "growth", "quality", "safety", "meta"] as const;

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span><span className="text-foreground font-medium">{data.length}</span> tickers</span>
          <span><span className="text-foreground font-medium">{data.filter(d => d.isWatchlist).length}</span> watchlist</span>
          <span><span className="text-foreground font-medium">{data.filter(d => !d.isWatchlist).length}</span> peers only</span>
          <span><span className={cn("font-medium", noRow > 0 ? "text-red-400" : "text-green-400")}>{noRow}</span> missing rows</span>
          <span>Coverage <span className={cn("font-medium", coverage < 80 ? "text-amber-400" : "text-green-400")}>{coverage}%</span></span>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1 border border-border rounded hover:bg-secondary disabled:opacity-50"
        >
          <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      {/* Legend */}
      <div className="flex gap-3 text-xs">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-500/30 border border-red-500/50" /> Null</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-amber-500/30 border border-amber-500/50" /> Suspect</span>
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-blue-500/20 border border-blue-500/30" /> Watchlist</span>
      </div>

      {/* Grid */}
      <div className="border border-border rounded-md overflow-auto max-h-[calc(100vh-280px)]">
        <table className="text-xs border-collapse min-w-max">
          <thead className="sticky top-0 z-20 bg-background">
            {/* Family header row */}
            <tr>
              <th className="sticky left-0 z-30 bg-background border-b border-r border-border px-3 py-1.5 text-left font-medium" rowSpan={2}>
                Ticker
              </th>
              {families.map(fam => {
                const cols = COLS.filter(c => c.family === fam);
                return (
                  <th
                    key={fam}
                    colSpan={cols.length}
                    className={cn("border-b border-r border-border px-2 py-1 text-center font-semibold uppercase tracking-wider text-[10px]", FAMILY_COLORS[fam])}
                  >
                    {fam}
                  </th>
                );
              })}
            </tr>
            {/* Column labels row */}
            <tr>
              {COLS.map((col, i) => (
                <th
                  key={col.key as string}
                  className={cn(
                    "border-b border-border px-2 py-1 font-medium whitespace-nowrap",
                    i === COLS.length - 1 ? "" : "border-r",
                    FAMILY_COLORS[col.family],
                  )}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row, ri) => {
              const f = row.fundamentals;
              const fetchedAt = f?.fundamentalsLastFetched ?? null;
              const source    = f?.lastSource ?? "fmp";
              const tooltip   = fetchedAt
                ? `Last fetched ${fmtDate(fetchedAt)} · source: ${source}`
                : "No data fetched yet";

              return (
                <tr
                  key={row.ticker}
                  className={cn(
                    "border-b border-border hover:bg-muted/30 transition-colors",
                    ri % 2 === 0 ? "" : "bg-muted/10",
                  )}
                >
                  {/* Ticker cell — sticky */}
                  <td className="sticky left-0 z-10 bg-background border-r border-border px-3 py-1.5 font-mono font-semibold whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span>{row.ticker}</span>
                      {row.isWatchlist && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-blue-500/20 text-blue-400 border border-blue-500/30">WL</span>
                      )}
                      {!f && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">NO DATA</span>
                      )}
                    </div>
                    {row.peerGroupId && (
                      <div className="text-[9px] text-muted-foreground truncate max-w-[120px]">{row.peerGroupId.split(".")[1] ?? row.peerGroupId}</div>
                    )}
                  </td>

                  {/* Metric cells */}
                  {COLS.map((col, ci) => {
                    const raw = f ? (f[col.key] as string | null) : null;
                    const isNull = raw == null;
                    const suspect = isSuspect(col, raw);
                    const flags = f?.discrepancyFlags?.split(",") ?? [];
                    const hasFlag = flags.includes(col.key as string);

                    return (
                      <td
                        key={col.key as string}
                        title={tooltip + (hasFlag ? " · ⚠ triangulation flag" : "")}
                        className={cn(
                          "px-2 py-1 text-right font-mono whitespace-nowrap border-border transition-colors cursor-default",
                          ci < COLS.length - 1 && "border-r",
                          isNull   && "bg-red-500/15 text-red-400/70",
                          !isNull && suspect && "bg-amber-500/15 text-amber-300",
                          !isNull && !suspect && hasFlag && "bg-orange-500/15 text-orange-300",
                          !isNull && !suspect && !hasFlag && "text-foreground",
                        )}
                      >
                        {isNull ? <span className="text-red-500/50">null</span> : fmt(raw, col.fmt)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
