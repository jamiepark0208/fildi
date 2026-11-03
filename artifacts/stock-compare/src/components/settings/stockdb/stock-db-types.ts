// ── Types ─────────────────────────────────────────────────────────────────────

export interface FundamentalsRow {
  ticker: string;
  fundamentalsLastFetched: string | null;
  lastSource: string | null;
  fmpCoveragePercent: string | null;
  discrepancyFlags: string | null;
  overrideFlags: string | null;
  /** Fields overridden by Database Agent (`agent:` note) — purple cell ring. */
  agentOverrideFlags?: string | null;
  // VALUE
  peRatio: string | null; earningsPerShare: string | null; pegRatio: string | null; forwardPe: string | null; forwardEps: string | null; forwardPeg: string | null;
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
  // GAP inputs (fund-score-v2 derived: GPA, accruals, ND/EBITDA)
  grossProfit: string | null; totalAssets: string | null; annualOperatingCashFlow: string | null;
  sharesOutstanding: string | null; sharesOutstandingPrior: string | null;
  beta: string | null; effectiveTaxRate: string | null;
  // Persisted scores (optional display)
  fundTotalScore?: string | null;
  fundCompanyScore?: string | null;
  fundSectorScore?: string | null;
  fundValueScore?: string | null;
  fundQualityScore?: string | null;
  fundGrowthScore?: string | null;
  fundSafetyScore?: string | null;
  styleBucket?: string | null;
}

export interface TechnicalsRow {
  regime: string | null; fallingKnife: number | null; earningsDaysOut: number | null;
  rsi14: string | null; mfi14: string | null; stoch: string | null;
  macdDirection: string | null; rsiVelocity: string | null;
  volumeRatio: string | null;
  realizedVol20d: string | null; ivRank: string | null; atmPutIv: string | null;
  impliedMoveWeekly: string | null; bbWidthPct: string | null;
  priceVsMa20Atr: string | null; priceVsMa50Atr: string | null;
  priceZScore: string | null; priceVsVwapPct: string | null;
  technicalsLastFetched: string | null;
}

export interface StockDBEntry {
  ticker: string;
  companyName: string | null;
  isWatchlist: boolean;
  /** Manually marked peer anchor. Not the watchlist flag, and not a score input. */
  isPeerRep: boolean;
  /** Latest close × shares outstanding. */
  marketCap: number | null;
  peerGroupId: string | null;
  peerGroupName: string | null;
  fundamentals: FundamentalsRow | null;
  technicals: TechnicalsRow | null;
  signal: string | null;
}

// ── Provenance types (matches GET /api/fundamentals/provenance/:ticker) ───────

export interface SourceEntry {
  source: string;
  value: number | null;
  fetchedAt: string | null;
  lastQueriedAt: string | null;
  status: "used" | "available" | "excluded" | "no_data";
  exclusionReason?: string;
}
export interface ResearchEntry {
  source: "wrds" | "lseg" | "schwab" | string;
  value: number | null;
  fetchedAt: string | null;
  status: "available" | "no_data" | "n/a";
  note?: string;
}
export interface FieldProv {
  field: string;
  winningSource: string | null;
  winningValue: number | null;
  isOverride: boolean;
  divergent: boolean;
  fetchedAt: string | null;
  isAgentOverride?: boolean;
  agentNote?: string | null;
  override: { source: string; value: number | null; note: string | null; createdAt: string } | null;
  sources: SourceEntry[];
  research?: ResearchEntry[];
}
export interface ProvenanceData { ticker: string; fields: FieldProv[] }
export interface DivergentItem {
  ticker: string;
  field: string;
  winningSource: string | null;
  winningValue: number | null;
  fetchedAt: string | null;
}
export interface QueueItem {
  id: number;
  ticker: string;
  field: string;
  source: string;
  status: "pending" | "running" | "done" | "failed";
  queuedAt: string;
}

// ── Grouping helpers ──────────────────────────────────────────────────────────

export function formatSector(id: string): string {
  return id.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

export type FamilyCovSummary = Record<string, { filled: number; total: number }>;

export type DisplayRow =
  | { kind: "sector"; sectorId: string; label: string; count: number; coverage: number; famCov: FamilyCovSummary }
  | { kind: "group";  sectorId: string; groupId: string; groupName: string; count: number; coverage: number; entries: StockDBEntry[] }
  | { kind: "row";    sectorId: string; groupId: string; entry: StockDBEntry; ri: number };

// ── Pipeline health (enrichment run history) ─────────────────────────────────

export interface EnrichmentRun {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: "success" | "partial" | "failed";
  trigger: "scheduled" | "manual" | "maintain" | "maintain_full";
  perSource: Record<string, { targeted: number; fetched: number; nodata: number; failed: number; budgetSkipped: number }> | null;
  coverageBefore: string | null;
  coverageAfter: string | null;
  error: string | null;
  flagAuditOrphaned: number | null;
  flagAuditMissing: number | null;
}
