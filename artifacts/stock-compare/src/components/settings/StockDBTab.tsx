import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle, RefreshCw, ChevronUp, ChevronDown, ChevronRight, Search, Pin, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverAnchor } from "@/components/ui/popover";

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
  companyName: string | null;
  isWatchlist: boolean;
  peerGroupId: string | null;
  peerGroupName: string | null;
  fundamentals: FundamentalsRow | null;
}

// ── Provenance types (matches GET /api/fundamentals/provenance/:ticker) ───────

interface SourceEntry {
  source: string;
  value: number | null;
  fetchedAt: string | null;
  status: "used" | "available" | "excluded" | "no_data";
  exclusionReason?: string;
}
interface FieldProv {
  field: string;
  winningSource: string | null;
  winningValue: number | null;
  isOverride: boolean;
  divergent: boolean;
  fetchedAt: string | null;
  override: { source: string; value: number | null; note: string | null; createdAt: string } | null;
  sources: SourceEntry[];
}
interface ProvenanceData { ticker: string; fields: FieldProv[] }

// ── Grouping helpers ──────────────────────────────────────────────────────────

function formatSector(id: string): string {
  return id.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

type DisplayRow =
  | { kind: "sector"; sectorId: string; label: string; count: number; coverage: number }
  | { kind: "group";  sectorId: string; groupId: string; groupName: string; count: number; coverage: number }
  | { kind: "row";    sectorId: string; groupId: string; entry: StockDBEntry; ri: number };

// ── Column definitions ────────────────────────────────────────────────────────

type FmtType = "pct" | "ratio" | "dollars" | "price" | "shares";

interface ColDef {
  key: keyof FundamentalsRow;
  label: string;
  family: "value" | "growth" | "quality" | "safety" | "meta";
  fmt: FmtType;
  suspect?: (v: number) => boolean;
  optional?: boolean;
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

(COLS.find(c => c.label === "Qtrly OCF") as ColDef).key = "quarterlyOperatingCashFlow" as keyof FundamentalsRow;

const FAMILY_COLORS: Record<string, string> = {
  value:   "text-blue-400",
  growth:  "text-green-400",
  quality: "text-purple-400",
  safety:  "text-amber-400",
  meta:    "text-muted-foreground",
};

// ── Coverage helpers ──────────────────────────────────────────────────────────

function calcCoverage(entries: StockDBEntry[]): number {
  if (!entries.length) return 0;
  let filled = 0;
  for (const e of entries) {
    for (const col of COLS) {
      if (e.fundamentals?.[col.key] != null) filled++;
    }
  }
  return Math.round((filled / (entries.length * COLS.length)) * 100);
}

function coverageColor(pct: number): string {
  return pct < 50 ? "text-red-400" : pct < 80 ? "text-amber-400" : "text-green-400";
}

function coverageBarColor(pct: number): string {
  return pct < 50 ? "bg-red-500/70" : pct < 80 ? "bg-amber-500/60" : "bg-green-500/60";
}

// ── Sector color palettes ─────────────────────────────────────────────────────

interface SectorPalette { bg: string; border: string; text: string; badge: string; chevron: string }

const SECTOR_PALETTE: Record<string, SectorPalette> = {
  technology:    { bg: "bg-blue-950/90",    border: "border-l-blue-500",    text: "text-blue-200",    badge: "bg-blue-500/25 text-blue-300 border border-blue-500/40",    chevron: "text-blue-400" },
  financial:     { bg: "bg-emerald-950/90", border: "border-l-emerald-500", text: "text-emerald-200", badge: "bg-emerald-500/25 text-emerald-300 border border-emerald-500/40", chevron: "text-emerald-400" },
  healthcare:    { bg: "bg-violet-950/90",  border: "border-l-violet-500",  text: "text-violet-200",  badge: "bg-violet-500/25 text-violet-300 border border-violet-500/40",  chevron: "text-violet-400" },
  energy:        { bg: "bg-orange-950/90",  border: "border-l-orange-500",  text: "text-orange-200",  badge: "bg-orange-500/25 text-orange-300 border border-orange-500/40",  chevron: "text-orange-400" },
  consumer:      { bg: "bg-rose-950/90",    border: "border-l-rose-500",    text: "text-rose-200",    badge: "bg-rose-500/25 text-rose-300 border border-rose-500/40",    chevron: "text-rose-400" },
  industrial:    { bg: "bg-cyan-950/90",    border: "border-l-cyan-500",    text: "text-cyan-200",    badge: "bg-cyan-500/25 text-cyan-300 border border-cyan-500/40",    chevron: "text-cyan-400" },
  real_estate:   { bg: "bg-yellow-950/90",  border: "border-l-yellow-500",  text: "text-yellow-200",  badge: "bg-yellow-500/25 text-yellow-300 border border-yellow-500/40",  chevron: "text-yellow-400" },
  utilities:     { bg: "bg-teal-950/90",    border: "border-l-teal-500",    text: "text-teal-200",    badge: "bg-teal-500/25 text-teal-300 border border-teal-500/40",    chevron: "text-teal-400" },
  materials:     { bg: "bg-lime-950/90",    border: "border-l-lime-500",    text: "text-lime-200",    badge: "bg-lime-500/25 text-lime-300 border border-lime-500/40",    chevron: "text-lime-400" },
  communication: { bg: "bg-indigo-950/90",  border: "border-l-indigo-500",  text: "text-indigo-200",  badge: "bg-indigo-500/25 text-indigo-300 border border-indigo-500/40",  chevron: "text-indigo-400" },
};
const DEFAULT_SECTOR_PALETTE: SectorPalette = { bg: "bg-zinc-900/90", border: "border-l-zinc-500", text: "text-zinc-200", badge: "bg-zinc-500/25 text-zinc-300 border border-zinc-500/40", chevron: "text-zinc-400" };

function getSectorPalette(sectorId: string): SectorPalette {
  const k = Object.keys(SECTOR_PALETTE).find(key => sectorId.toLowerCase().includes(key));
  return k ? SECTOR_PALETTE[k] : DEFAULT_SECTOR_PALETTE;
}

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
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30)  return `${days}d ago`;
  return d.toLocaleDateString();
}

function SortIcon({ colKey, sortCol, sortDir }: { colKey: string; sortCol: string | null; sortDir: "asc" | "desc" }) {
  if (sortCol !== colKey) return <span className="opacity-20 ml-0.5 inline-block w-2.5 text-center">↕</span>;
  return sortDir === "asc"
    ? <ChevronUp className="inline h-3 w-3 ml-0.5 -mt-0.5" />
    : <ChevronDown className="inline h-3 w-3 ml-0.5 -mt-0.5" />;
}

// ── Persistent collapse state (survives tab switches) ─────────────────────────

const _persist = {
  collapsedSectors: new Set<string>(),
  collapsedGroups:  new Set<string>(),
  groupsInitialized: false,
};

// ── Main component ────────────────────────────────────────────────────────────

const families = ["value", "growth", "quality", "safety", "meta"] as const;

type ActiveCell = { ticker: string; field: string; rect: DOMRect };

export function StockDBTab() {
  const qc = useQueryClient();
  const [tickerFilter, setTickerFilter]         = useState("");
  const [sortCol, setSortCol]                   = useState<string | null>(null);
  const [sortDir, setSortDir]                   = useState<"asc" | "desc">("asc");
  const [hoveredTicker, setHoveredTicker]       = useState<string | null>(null);
  const [activeCell, setActiveCell]             = useState<ActiveCell | null>(null);
  const [overrideSrc, setOverrideSrc]           = useState("");
  const [overrideVal, setOverrideVal]           = useState("");
  const [overrideNote, setOverrideNote]         = useState("");
  const [collapsedSectors, setCollapsedSectors] = useState<Set<string>>(() => new Set(_persist.collapsedSectors));
  const [collapsedGroups, setCollapsedGroups]   = useState<Set<string>>(() => new Set(_persist.collapsedGroups));
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<StockDBEntry[]>({
    queryKey: ["admin-stock-db"],
    queryFn: async () => {
      const r = await fetch("/api/fundamentals/stock-db", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  // On first data load: collapse all groups by default, leave sectors expanded
  useEffect(() => {
    if (!data || _persist.groupsInitialized) return;
    const allGroupIds = new Set(data.filter(e => e.peerGroupId).map(e => e.peerGroupId!));
    _persist.collapsedGroups = allGroupIds;
    _persist.groupsInitialized = true;
    setCollapsedGroups(new Set(allGroupIds));
  }, [data]);

  const { data: provData, isFetching: provFetching, isError: provError, refetch: refetchProv } = useQuery<ProvenanceData>({
    queryKey: ["provenance", hoveredTicker],
    queryFn: async ({ signal }) => {
      const r = await fetch(`/api/fundamentals/provenance/${hoveredTicker}`, { credentials: "include", signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!hoveredTicker,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const activeProv: FieldProv | null = useMemo(() => {
    if (!activeCell || !provData) return null;
    return (provData.fields ?? []).find(f => f.field === activeCell.field) ?? null;
  }, [activeCell, provData]);

  const overrideMutation = useMutation({
    mutationFn: async ({ ticker, field, source, value, note }: { ticker: string; field: string; source: string; value?: string; note?: string }) => {
      const r = await fetch("/api/fundamentals/override", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, field, source, value: value || undefined, note }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: (_, { ticker }) => {
      qc.invalidateQueries({ queryKey: ["provenance", ticker] });
      qc.invalidateQueries({ queryKey: ["admin-stock-db"] });
    },
  });

  const clearOverrideMutation = useMutation({
    mutationFn: async ({ ticker, field }: { ticker: string; field: string }) => {
      const r = await fetch(`/api/fundamentals/override/${ticker}/${field}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: (_, { ticker }) => {
      qc.invalidateQueries({ queryKey: ["provenance", ticker] });
      qc.invalidateQueries({ queryKey: ["admin-stock-db"] });
    },
  });

  const openCell = useCallback((ticker: string, field: string, e: React.MouseEvent<HTMLTableCellElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setActiveCell({ ticker, field, rect });
    setOverrideSrc(activeProv?.override?.source ?? "");
    setOverrideVal(activeProv?.override?.value != null ? String(activeProv.override.value) : "");
    setOverrideNote(activeProv?.override?.note ?? "");
  }, [activeProv]);

  const onRowEnter = useCallback((ticker: string) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredTicker(ticker);
  }, []);

  const onRowLeave = useCallback(() => {
    hoverTimerRef.current = setTimeout(() => setHoveredTicker(null), 2000);
  }, []);

  function handleSort(colKey: string) {
    if (sortCol === colKey) {
      setSortDir(d => d === "asc" ? "desc" : "asc");
    } else {
      setSortCol(colKey);
      setSortDir("asc");
    }
  }

  function toggleSector(sectorId: string) {
    setCollapsedSectors(s => {
      const next = new Set(s);
      if (next.has(sectorId)) next.delete(sectorId); else next.add(sectorId);
      _persist.collapsedSectors = next;
      return next;
    });
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups(s => {
      const next = new Set(s);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      _persist.collapsedGroups = next;
      return next;
    });
  }

  // Per-column and per-family coverage computed over the full dataset
  const colCoverage = useMemo(() => {
    if (!data) return {} as Record<string, { filled: number; total: number }>;
    return Object.fromEntries(
      COLS.map(col => {
        const filled = data.filter(r => r.fundamentals?.[col.key] != null).length;
        return [col.key as string, { filled, total: data.length }];
      })
    );
  }, [data]);

  const familyCoverage = useMemo(() => {
    if (!data) return {} as Record<string, { filled: number; total: number }>;
    return Object.fromEntries(
      families.map(fam => {
        const famCols = COLS.filter(c => c.family === fam);
        let filled = 0, total = 0;
        for (const row of data) {
          for (const col of famCols) {
            total++;
            if (row.fundamentals?.[col.key] != null) filled++;
          }
        }
        return [fam, { filled, total }];
      })
    );
  }, [data]);

  // Filter + sort + group — sectors/groups sorted by coverage % descending
  const displayData = useMemo((): DisplayRow[] => {
    if (!data) return [];

    const lc = tickerFilter.toLowerCase().trim();
    const filtered = lc
      ? data.filter(r => r.ticker.toLowerCase().includes(lc) || (r.companyName ?? "").toLowerCase().includes(lc))
      : data;

    const sortFn = (a: StockDBEntry, b: StockDBEntry): number => {
      if (sortCol) {
        if (sortCol === "ticker") {
          const cmp = a.ticker.localeCompare(b.ticker);
          return sortDir === "asc" ? cmp : -cmp;
        }
        const aRaw = a.fundamentals?.[sortCol as keyof FundamentalsRow] ?? null;
        const bRaw = b.fundamentals?.[sortCol as keyof FundamentalsRow] ?? null;
        const aVal = aRaw != null ? parseFloat(aRaw as string) : null;
        const bVal = bRaw != null ? parseFloat(bRaw as string) : null;
        if (aVal == null && bVal == null) return 0;
        if (aVal == null) return 1;
        if (bVal == null) return -1;
        return sortDir === "asc" ? aVal - bVal : bVal - aVal;
      }
      if (a.isWatchlist !== b.isWatchlist) return a.isWatchlist ? -1 : 1;
      return a.ticker.localeCompare(b.ticker);
    };

    // Build sector → group → entries map
    const sectorMap = new Map<string, Map<string, StockDBEntry[]>>();
    const unclassified: StockDBEntry[] = [];

    for (const entry of filtered) {
      if (!entry.peerGroupId) { unclassified.push(entry); continue; }
      const sectorId = entry.peerGroupId.split(".")[0];
      if (!sectorMap.has(sectorId)) sectorMap.set(sectorId, new Map());
      const groups = sectorMap.get(sectorId)!;
      if (!groups.has(entry.peerGroupId)) groups.set(entry.peerGroupId, []);
      groups.get(entry.peerGroupId)!.push(entry);
    }

    // Build sector list with per-group coverage; sort sectors and groups by coverage desc
    const sectorList = [...sectorMap.entries()].map(([sectorId, groups]) => {
      const groupList = [...groups.entries()].map(([groupId, entries]) => ({
        groupId,
        groupName: entries[0]?.peerGroupName ?? groupId.split(".")[1] ?? groupId,
        entries: entries.sort(sortFn),
        coverage: calcCoverage(entries),
        count: entries.length,
      }));
      groupList.sort((a, b) => b.count - a.count);
      const allEntries = groupList.flatMap(g => g.entries);
      return { sectorId, label: formatSector(sectorId), groups: groupList, coverage: calcCoverage(allEntries), count: allEntries.length };
    });
    sectorList.sort((a, b) => b.coverage - a.coverage);

    const rows: DisplayRow[] = [];
    let ri = 0;

    for (const sector of sectorList) {
      rows.push({ kind: "sector", sectorId: sector.sectorId, label: sector.label, count: sector.count, coverage: sector.coverage });
      for (const group of sector.groups) {
        rows.push({ kind: "group", sectorId: sector.sectorId, groupId: group.groupId, groupName: group.groupName, count: group.entries.length, coverage: group.coverage });
        for (const entry of group.entries) {
          rows.push({ kind: "row", sectorId: sector.sectorId, groupId: group.groupId, entry, ri: ri++ });
        }
      }
    }

    if (unclassified.length > 0) {
      const unc = unclassified.sort(sortFn);
      const uncCov = calcCoverage(unc);
      rows.push({ kind: "sector", sectorId: "__unclassified", label: "Unclassified", count: unc.length, coverage: uncCov });
      rows.push({ kind: "group", sectorId: "__unclassified", groupId: "__unclassified", groupName: "No peer group", count: unc.length, coverage: uncCov });
      for (const entry of unc) {
        rows.push({ kind: "row", sectorId: "__unclassified", groupId: "__unclassified", entry, ri: ri++ });
      }
    }

    return rows;
  }, [data, tickerFilter, sortCol, sortDir]);

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
  const visibleRows = displayData.filter(r => r.kind === "row").length;

  return (
    <>
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span><span className="text-foreground font-medium">{data.length}</span> tickers</span>
          <span><span className="text-foreground font-medium">{data.filter(d => d.isWatchlist).length}</span> watchlist</span>
          <span><span className="text-foreground font-medium">{data.filter(d => !d.isWatchlist).length}</span> peers only</span>
          <span><span className={cn("font-medium", noRow > 0 ? "text-red-400" : "text-green-400")}>{noRow}</span> missing rows</span>
          <span>Coverage <span className={cn("font-medium", coverageColor(coverage))}>{coverage}%</span></span>
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

      {/* Ticker filter + legend */}
      <div className="flex items-center justify-between gap-4">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={tickerFilter}
            onChange={e => setTickerFilter(e.target.value)}
            placeholder="Filter tickers…"
            className="pl-6 pr-3 py-1 text-xs bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-ring w-44"
          />
          {tickerFilter && (
            <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">
              {visibleRows}/{data.length}
            </span>
          )}
        </div>
        <div className="flex gap-3 text-xs">
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-500/30 border border-red-500/50" /> Null</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-amber-500/30 border border-amber-500/50" /> Suspect</span>
          <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-blue-500/20 border border-blue-500/40" /> Representative</span>
        </div>
      </div>

      {/* Grid */}
      <div className="border border-border rounded-md overflow-auto max-h-[calc(100vh-300px)]">
        <table className="text-xs border-collapse min-w-max">
          <thead className="sticky top-0 z-20 bg-background">
            {/* Family header row */}
            <tr>
              <th
                className="sticky left-0 z-30 bg-background border-b border-r border-border px-3 py-1.5 text-left font-medium cursor-pointer hover:bg-muted/30 select-none"
                rowSpan={2}
                onClick={() => handleSort("ticker")}
              >
                <span className="flex items-center gap-0.5">
                  Ticker
                  <SortIcon colKey="ticker" sortCol={sortCol} sortDir={sortDir} />
                </span>
              </th>
              {families.map(fam => {
                const cols = COLS.filter(c => c.family === fam);
                const cov = familyCoverage[fam];
                const pct = cov && cov.total > 0 ? Math.round((cov.filled / cov.total) * 100) : 0;
                return (
                  <th
                    key={fam}
                    colSpan={cols.length}
                    className={cn("border-b border-r border-border px-2 py-1 text-center font-semibold uppercase tracking-wider text-[10px]", FAMILY_COLORS[fam])}
                  >
                    <div>{fam}</div>
                    <div className={cn("text-[9px] font-normal tracking-normal normal-case mt-0.5 opacity-80", coverageColor(pct))}>
                      {cov ? `${cov.filled}/${cov.total * cols.length} filled · ${pct}%` : "—"}
                    </div>
                  </th>
                );
              })}
            </tr>
            {/* Column labels row */}
            <tr>
              {COLS.map((col, i) => {
                const cov = colCoverage[col.key as string];
                const pct = cov && cov.total > 0 ? Math.round((cov.filled / cov.total) * 100) : 0;
                return (
                  <th
                    key={col.key as string}
                    onClick={() => handleSort(col.key as string)}
                    className={cn(
                      "border-b border-border px-2 py-1 font-medium whitespace-nowrap cursor-pointer hover:bg-muted/30 select-none",
                      i === COLS.length - 1 ? "" : "border-r",
                      FAMILY_COLORS[col.family],
                    )}
                  >
                    <div className="flex items-center justify-end gap-0.5">
                      <span>{col.label}</span>
                      <SortIcon colKey={col.key as string} sortCol={sortCol} sortDir={sortDir} />
                    </div>
                    {cov && (
                      <div className={cn(
                        "text-[9px] font-normal text-right mt-0.5",
                        pct === 0 ? "text-red-400/70" : pct < 50 ? "text-red-400" : pct < 80 ? "text-amber-400" : "text-green-500/70"
                      )}>
                        {cov.filled}/{cov.total}
                      </div>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {displayData.map((item, idx) => {
              // ── Sector header ──────────────────────────────────────────────
              if (item.kind === "sector") {
                const isCollapsed = collapsedSectors.has(item.sectorId);
                const pal = getSectorPalette(item.sectorId);
                return (
                  <tr
                    key={`sector-${item.sectorId}`}
                    className="cursor-pointer select-none"
                    onClick={() => toggleSector(item.sectorId)}
                  >
                    <td colSpan={COLS.length + 1} className={cn("p-0 border-l-4", pal.border)}>
                      <div className={cn("flex items-center gap-2.5 px-3 py-2.5", pal.bg)}>
                        {isCollapsed
                          ? <ChevronRight className={cn("h-3.5 w-3.5 flex-shrink-0", pal.chevron)} />
                          : <ChevronDown  className={cn("h-3.5 w-3.5 flex-shrink-0", pal.chevron)} />
                        }
                        <span className={cn("font-bold text-[11px] uppercase tracking-widest", pal.text)}>{item.label}</span>
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium", pal.badge)}>{item.count} tickers</span>
                        <div className="ml-auto flex items-center gap-2.5">
                          <div className="w-20 h-1.5 rounded-full bg-black/40 overflow-hidden">
                            <div className={cn("h-full rounded-full", coverageBarColor(item.coverage))} style={{ width: `${item.coverage}%` }} />
                          </div>
                          <span className={cn("text-[10px] font-semibold tabular-nums w-10 text-right", coverageColor(item.coverage))}>
                            {item.coverage}%
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              }

              // ── Group header ───────────────────────────────────────────────
              if (item.kind === "group") {
                if (collapsedSectors.has(item.sectorId)) return null;
                const isCollapsed = collapsedGroups.has(item.groupId);
                const pal = getSectorPalette(item.sectorId);
                return (
                  <tr
                    key={`group-${item.groupId}-${idx}`}
                    className="cursor-pointer select-none hover:bg-white/[0.03] transition-colors border-b border-border/30"
                    onClick={() => toggleGroup(item.groupId)}
                  >
                    <td colSpan={COLS.length + 1} className={cn("p-0 border-l-4", pal.border)}>
                      <div className="flex items-center gap-2.5 pl-7 pr-3 py-1.5 bg-white/[0.04]">
                        {isCollapsed
                          ? <ChevronRight className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
                          : <ChevronDown  className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
                        }
                        <span className="text-xs font-semibold text-white uppercase tracking-wider">{item.groupName}</span>
                        <span className="text-[10px] text-muted-foreground/60 font-mono">{item.count}</span>
                        <div className="ml-auto flex items-center gap-2">
                          <div className="w-16 h-1 rounded-full bg-muted/40 overflow-hidden">
                            <div className={cn("h-full rounded-full", coverageBarColor(item.coverage))} style={{ width: `${item.coverage}%` }} />
                          </div>
                          <span className={cn("text-[10px] tabular-nums w-8 text-right font-medium", coverageColor(item.coverage))}>
                            {item.coverage}%
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                );
              }

              // ── Data row ───────────────────────────────────────────────────
              if (collapsedSectors.has(item.sectorId) || collapsedGroups.has(item.groupId)) return null;

              const { entry: row, ri } = item;
              const f = row.fundamentals;

              return (
                <tr
                  key={row.ticker}
                  className={cn(
                    "border-b border-border/50 hover:bg-muted/30 transition-colors",
                    row.isWatchlist
                      ? "bg-amber-500/8 border-l-2 border-l-amber-500/50"
                      : ri % 2 === 0 ? "" : "bg-muted/5",
                  )}
                  onMouseEnter={() => onRowEnter(row.ticker)}
                  onMouseLeave={onRowLeave}
                >
                  {/* Ticker cell — sticky */}
                  <td className={cn(
                    "sticky left-0 z-10 border-r border-border px-2.5 py-0.5 font-mono font-semibold whitespace-nowrap",
                    row.isWatchlist ? "bg-amber-950/30" : "bg-background",
                  )}>
                    <div className="flex items-center gap-1.5">
                      <span className={row.isWatchlist ? "text-amber-300" : ""}>{row.ticker}</span>
                      {row.isWatchlist && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/25 text-amber-400 border border-amber-500/40 font-sans font-medium">rep</span>
                      )}
                      {!f && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">NO DATA</span>
                      )}
                    </div>
                    {row.companyName && (
                      <div className="text-[9px] text-muted-foreground truncate max-w-[120px]">{row.companyName}</div>
                    )}
                  </td>

                  {/* Metric cells */}
                  {COLS.map((col, ci) => {
                    const raw = f ? (f[col.key] as string | null) : null;
                    const isNull = raw == null;
                    const isOptionalNull = isNull && !!col.optional;
                    const suspect = isSuspect(col, raw);
                    const flags = f?.discrepancyFlags?.split(",") ?? [];
                    const hasFlag = flags.includes(col.key as string);
                    const isActive = activeCell?.ticker === row.ticker && activeCell?.field === (col.key as string);

                    return (
                      <td
                        key={col.key as string}
                        onClick={(e) => openCell(row.ticker, col.key as string, e)}
                        className={cn(
                          "px-2 py-0.5 text-right font-mono whitespace-nowrap border-border transition-colors cursor-pointer",
                          ci < COLS.length - 1 && "border-r",
                          isActive && "ring-1 ring-inset ring-primary/50",
                          isOptionalNull && "text-muted-foreground/40",
                          !isOptionalNull && isNull && "bg-red-500/15 text-red-400/70",
                          !isNull && suspect && "bg-amber-500/15 text-amber-300",
                          !isNull && !suspect && hasFlag && "bg-orange-500/15 text-orange-300",
                          !isNull && !suspect && !hasFlag && "text-foreground",
                        )}
                      >
                        {isOptionalNull ? "—" : isNull ? <span className="text-red-500/50">null</span> : fmt(raw, col.fmt)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {visibleRows === 0 && tickerFilter && (
              <tr>
                <td colSpan={COLS.length + 1} className="py-8 text-center text-muted-foreground text-xs">
                  No tickers match "{tickerFilter}"
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
    {/* ── Provenance Popover ─────────────────────────────────────────────── */}
    <Popover open={!!activeCell} onOpenChange={(open) => { if (!open) setActiveCell(null); }}>
      <PopoverAnchor asChild>
        <div
          style={{
            position: "fixed",
            left:   activeCell?.rect.left  ?? 0,
            top:    activeCell?.rect.bottom ?? 0,
            width:  activeCell?.rect.width  ?? 0,
            height: 0,
            pointerEvents: "none",
          }}
        />
      </PopoverAnchor>

      <PopoverContent
        className="w-80 p-0 text-xs overflow-hidden"
        align="start"
        sideOffset={4}
        onInteractOutside={() => setActiveCell(null)}
      >
        {!activeProv && provError && (
          <div className="p-3 flex flex-col gap-2">
            <div className="text-red-400 flex items-center gap-1.5 text-xs">
              <AlertTriangle className="h-3 w-3" /> Couldn't load source detail.
            </div>
            <button
              onClick={() => refetchProv()}
              className="text-[10px] px-2 py-1 border border-border rounded hover:bg-secondary self-start"
            >
              Retry
            </button>
          </div>
        )}
        {!activeProv && !provError && (
          <div className="p-3 text-muted-foreground flex items-center gap-2">
            {provFetching
              ? <><Loader2 className="h-3 w-3 animate-spin" /> Loading provenance…</>
              : "Hover the row first to load provenance."}
          </div>
        )}
        {activeProv && (
          <div>
            <div className="px-3 py-2 border-b border-border bg-muted/30 flex items-center justify-between gap-2">
              <span className="font-semibold text-foreground">{activeCell?.ticker} · {activeCell?.field}</span>
              <div className="flex items-center gap-1">
                {activeProv.isOverride && <span title="Manual override active"><Pin className="h-3 w-3 text-amber-400" /></span>}
                {activeProv.divergent  && <span title="Sources disagree"><TriangleAlert className="h-3 w-3 text-orange-400" /></span>}
              </div>
            </div>

            <div className="px-3 py-2 border-b border-border">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Winner</span>
                <span className="font-mono font-medium">
                  {activeProv.winningValue != null
                    ? activeProv.winningValue.toPrecision(5)
                    : <span className="text-red-400/70">null</span>}
                </span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-muted-foreground">Source</span>
                <span className="font-mono">{activeProv.winningSource ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-muted-foreground">Age</span>
                <span className="font-mono">{fmtDate(activeProv.fetchedAt)}</span>
              </div>
              {activeProv.divergent && (
                <div className="mt-1.5 text-[10px] text-orange-400 flex items-center gap-1">
                  <TriangleAlert className="h-2.5 w-2.5" /> Sources disagree on this value
                </div>
              )}
            </div>

            <div className="px-3 py-2 border-b border-border">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">All sources</div>
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left font-normal pb-0.5">Source</th>
                    <th className="text-right font-normal pb-0.5">Value</th>
                    <th className="text-right font-normal pb-0.5">Age</th>
                    <th className="text-right font-normal pb-0.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {activeProv.sources.map(s => (
                    <tr key={s.source} className={cn(s.status === "excluded" || s.status === "no_data" ? "text-muted-foreground/50" : "")}>
                      <td className="py-px">{s.source}</td>
                      <td className="text-right font-mono py-px">
                        {s.value != null ? s.value.toPrecision(4) : "—"}
                      </td>
                      <td className="text-right py-px">{fmtDate(s.fetchedAt)}</td>
                      <td className="text-right py-px">
                        {s.status === "used"      && <span className="text-green-400">used</span>}
                        {s.status === "available" && <span className="text-blue-400">avail</span>}
                        {s.status === "no_data"   && <span>—</span>}
                        {s.status === "excluded"  && (
                          <span className="text-muted-foreground/40" title={s.exclusionReason}>excl</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-3 py-2">
              <div className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">
                {activeProv.override ? "Override active" : "Override source"}
              </div>
              <div className="flex flex-col gap-1.5">
                <select
                  value={overrideSrc}
                  onChange={e => { setOverrideSrc(e.target.value); setOverrideVal(""); }}
                  className="w-full text-[10px] bg-background border border-border rounded px-1.5 py-1"
                >
                  <option value="">— pick source —</option>
                  {activeProv.sources
                    .filter(s => s.status !== "excluded")
                    .map(s => <option key={s.source} value={s.source}>{s.source}</option>)}
                  <option value="manual">manual value</option>
                </select>
                {overrideSrc === "manual" && (
                  <input
                    type="number"
                    value={overrideVal}
                    onChange={e => setOverrideVal(e.target.value)}
                    placeholder="numeric value"
                    className="w-full text-[10px] bg-background border border-border rounded px-1.5 py-1 font-mono"
                  />
                )}
                <input
                  type="text"
                  value={overrideNote}
                  onChange={e => setOverrideNote(e.target.value)}
                  placeholder="note (optional)"
                  className="w-full text-[10px] bg-background border border-border rounded px-1.5 py-1"
                />
                <div className="flex gap-1.5">
                  <button
                    disabled={!overrideSrc || overrideMutation.isPending}
                    onClick={() => {
                      if (!activeCell || !overrideSrc) return;
                      overrideMutation.mutate({
                        ticker: activeCell.ticker,
                        field:  activeCell.field,
                        source: overrideSrc,
                        value:  overrideSrc === "manual" ? overrideVal : undefined,
                        note:   overrideNote || undefined,
                      });
                    }}
                    className="flex-1 text-[10px] py-1 rounded bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90"
                  >
                    {overrideMutation.isPending ? "Saving…" : "Save"}
                  </button>
                  {activeProv.override && (
                    <button
                      disabled={clearOverrideMutation.isPending}
                      onClick={() => {
                        if (!activeCell) return;
                        clearOverrideMutation.mutate({ ticker: activeCell.ticker, field: activeCell.field });
                        setOverrideSrc(""); setOverrideVal(""); setOverrideNote("");
                      }}
                      className="flex-1 text-[10px] py-1 rounded border border-border hover:bg-muted/50 disabled:opacity-40"
                    >
                      {clearOverrideMutation.isPending ? "Clearing…" : "Clear override"}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
    </>
  );
}
