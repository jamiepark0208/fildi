import { Fragment, useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, AlertTriangle, RefreshCw, ChevronUp, ChevronDown, ChevronRight, Search, Pin, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverAnchor } from "@/components/ui/popover";
import { useAuth } from "@/context/AuthContext";
import type {
  FundamentalsRow, StockDBEntry, FieldProv, ProvenanceData,
  DivergentItem, QueueItem, FamilyCovSummary, DisplayRow, EnrichmentRun,
} from "./stockdb/stock-db-types";
import { formatSector } from "./stockdb/stock-db-types";
import {
  COLS, TECH_COLS, FAMILY_COLORS, TECH_FAMILY_COLORS, techFamilies, LOG_TRANSFORM_COLS, headerLines,
  HIGHER_IS_BETTER, LOWER_IS_BETTER, NEGATIVE_IS_BAD, colRole, COL_ROLE_NOTE,
  visibleFundCols, familyFieldCols, valueFieldCols, fundTableWidthPx, COL_W, SCORE_FAMILY_ORDER, type FundFamily,
} from "./stockdb/stock-db-columns";
import {
  getSectorPalette, coverageColor, coverageBarColor, FAMILY_LABEL, FAMILY_CHIP, FAMILY_SOLID, FAMILY_CELL_BG,
} from "./stockdb/stock-db-palette";
import {
  calcCoverage, fmt, isSuspect, computeGroupZScores, isNearZeroBase, fmtDate, enrichRunChip, sourceAgeLabel, sourceAgeTitle,
  groupMedian, groupTrimmedMean, numericMedian, trimmedMean, metricTone,
} from "./stockdb/stock-db-formatters";
import { VendorCrossCheckPanel } from "./stockdb/vendor-cross-check-panel";
import { StockDbSummaryBar } from "./stockdb/stock-db-summary-bar";
import { PeerGroupsTab } from "./PeerGroupsTab";
import { formatCompactCurrency } from "@/lib/format";

const DERIVED_INPUTS: Record<string, { label: string; field: string }[]> = {
  peRatio: [{ label: "EPS", field: "earningsPerShare" }],
  pegRatio: [{ label: "P/E", field: "peRatio" }, { label: "EPS growth", field: "epsGrowth" }],
  forwardPe: [{ label: "Fwd EPS", field: "forwardEps" }],
  forwardPeg: [{ label: "Fwd P/E", field: "forwardPe" }, { label: "EPS growth", field: "epsGrowth" }],
  priceToBook: [{ label: "Equity", field: "totalStockholdersEquity" }, { label: "Shares", field: "sharesOutstanding" }],
  priceToSales: [{ label: "Revenue", field: "totalRevenue" }, { label: "Shares", field: "sharesOutstanding" }],
  evEbitda: [{ label: "Debt", field: "totalDebt" }, { label: "Cash", field: "cashAndEquivalents" }, { label: "EBITDA", field: "ebitda" }, { label: "Shares", field: "sharesOutstanding" }],
  evRevenue: [{ label: "Debt", field: "totalDebt" }, { label: "Cash", field: "cashAndEquivalents" }, { label: "Revenue", field: "totalRevenue" }, { label: "Shares", field: "sharesOutstanding" }],
};

function fieldByName(data: ProvenanceData | undefined, field: string): FieldProv | null {
  return data?.fields.find(f => f.field === field) ?? null;
}

function usedSource(f: FieldProv) {
  return f.sources.find(s => s.status === "used" && s.value != null) ?? null;
}

function newerSourceNote(f: FieldProv): string | null {
  const used = usedSource(f);
  if (!used?.fetchedAt || used.value == null) return null;
  const usedT = Date.parse(used.fetchedAt);
  if (!Number.isFinite(usedT)) return null;
  let best: { text: string; t: number } | null = null;
  for (const s of f.sources) {
    if (s.source === used.source || s.value == null || !s.fetchedAt || s.status === "excluded") continue;
    const t = Date.parse(s.fetchedAt);
    if (!Number.isFinite(t) || t < usedT + 45 * 86_400_000) continue;
    if (best && t < best.t) continue;
    const gap = Math.abs(s.value - used.value) / Math.max(Math.abs(used.value), 1e-9);
    const when = fmtDate(s.fetchedAt);
    best = {
      t,
      text: gap > 0.05
        ? `Newer ${s.source} ${s.value.toPrecision(4)} on ${when} differs ${Math.round(gap * 100)}% from the gold source.`
        : `Newer ${s.source} ${s.value.toPrecision(4)} on ${when} agrees within ${Math.round(gap * 100)}%. Gold is still the older source.`,
    };
  }
  return best?.text ?? null;
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
  expandedFamily: null as FundFamily | null,
};

// ── Main component ────────────────────────────────────────────────────────────

const families = ["value", "growth", "quality", "safety", "meta"] as const;

function famCovFor(entries: { fundamentals?: FundamentalsRow | null }[]): FamilyCovSummary {
  return Object.fromEntries(
    families.map(fam => {
      const famCols = COLS.filter(c => c.family === fam);
      const filled = entries.reduce((acc, e) => acc + famCols.filter(c => e.fundamentals?.[c.key] != null).length, 0);
      return [fam, { filled, total: entries.length * famCols.length }];
    }),
  );
}

type ActiveCell = { ticker: string; field: string; rect: DOMRect; tooltipParts: string[]; tone?: "good" | "mid" | "bad"; z?: number };

function rankMarkTitle(tone: "good" | "mid" | "bad", z?: number): string {
  const place = tone === "good" ? "good end" : tone === "bad" ? "bad end" : "middle";
  if (z == null) return place + " of this sub-sector";
  const side = z > 0 ? "high" : z < 0 ? "low" : "at the median";
  return `z = ${z.toFixed(1)} · ${side} vs this sub-sector · ${place}`;
}

export function StockDBTab() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [tickerFilter, setTickerFilter]         = useState("");
  const [sortCol, setSortCol]                   = useState<string | null>(null);
  const [sortDir, setSortDir]                   = useState<"asc" | "desc">("asc");
  const [activeCell, setActiveCell]             = useState<ActiveCell | null>(null);
  const [overrideSrc, setOverrideSrc]           = useState("");
  const [overrideVal, setOverrideVal]           = useState("");
  const [overrideNote, setOverrideNote]         = useState("");
  const [collapsedSectors, setCollapsedSectors] = useState<Set<string>>(() => new Set(_persist.collapsedSectors));
  const [collapsedGroups, setCollapsedGroups]   = useState<Set<string>>(() => new Set(_persist.collapsedGroups));
  const [viewMode, setViewMode]                 = useState<"fundamentals" | "technicals" | "peers">("fundamentals");
  const [expandedFamily, setExpandedFamily]     = useState<FundFamily | null>(() => _persist.expandedFamily);

  const fundCols = useMemo(() => visibleFundCols(expandedFamily), [expandedFamily]);
  /** Pad empty field slots to widest family — expand/collapse keeps the same table width. */
  const maxFamilyFields = useMemo(
    () => Math.max(valueFieldCols().length, ...SCORE_FAMILY_ORDER.map(f => familyFieldCols(f).length)),
    [],
  );
  const widthPadCols = Math.max(0, maxFamilyFields - fundCols.filter(c => c.kind === "field").length);
  const fundColCount = fundCols.length + widthPadCols;
  const fundTableW = fundTableWidthPx(fundCols) + widthPadCols * COL_W.field;

  function toggleFamilyExpand(fam: FundFamily) {
    setExpandedFamily(cur => {
      const next = cur === fam ? null : fam;
      _persist.expandedFamily = next;
      return next;
    });
  }

  const { data: runsData } = useQuery<{ runs: EnrichmentRun[] }>({
    queryKey: ["enrichment-runs"],
    queryFn: async () => {
      const r = await fetch("/api/admin/enrichment-runs?limit=10", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: isAdmin,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  const latestRun = runsData?.runs?.[0] ?? null;
  const enrichChip = latestRun ? enrichRunChip(latestRun) : null;

  const [queueExpanded, setQueueExpanded] = useState(false);
  type QueueRunItem = { ticker: string; field: string; source: string; status: "done" | "failed" };
  const [queueRunResult, setQueueRunResult] = useState<{ processed: number; ok: number; failed: number; items: QueueRunItem[] } | null>(null);

  // Transient per-cell success flash — cleared after a few seconds, and never
  // persisted, so a page reload (or the next run) always starts clean.
  const [justSucceeded, setJustSucceeded] = useState<Set<string>>(new Set());
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashSuccessfulCells = useCallback((items: QueueRunItem[]) => {
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    const keys = new Set(items.filter(i => i.status === "done").map(i => `${i.ticker}:${i.field}`));
    setJustSucceeded(keys);
    flashTimerRef.current = setTimeout(() => setJustSucceeded(new Set()), 5_000);
  }, []);
  useEffect(() => () => { if (flashTimerRef.current) clearTimeout(flashTimerRef.current); }, []);
  const { data: queueData } = useQuery<{ queue: QueueItem[] }>({
    queryKey: ["refetch-queue"],
    queryFn: async () => {
      const r = await fetch("/api/fundamentals/queue-refetch", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: isAdmin,
    staleTime: 10_000,
    refetchInterval: queueExpanded ? 5_000 : false,
  });
  const refetchQueue = queueData?.queue ?? [];

  const queueRefetchMutation = useMutation({
    mutationFn: async ({ ticker, field, sources }: { ticker: string; field: string; sources: string[] }) => {
      const r = await fetch("/api/fundamentals/queue-refetch", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, field, sources }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["refetch-queue"] }),
  });

  const removeQueueItemMutation = useMutation({
    mutationFn: async (id: number) => {
      const r = await fetch(`/api/fundamentals/queue-refetch/${id}`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["refetch-queue"] }),
  });

  const runQueueMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/fundamentals/queue-refetch/run", { method: "POST", credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ processed: number; ok: number; failed: number; items: QueueRunItem[] }>;
    },
    onSuccess: (result) => {
      setQueueRunResult(result);
      flashSuccessfulCells(result.items);
      qc.invalidateQueries({ queryKey: ["refetch-queue"] });
      qc.invalidateQueries({ predicate: q => q.queryKey[0] === "provenance" });
      qc.invalidateQueries({ queryKey: ["admin-stock-db"] });
    },
  });

  const [reviewExpanded, setReviewExpanded] = useState(false);
  const { data: divergentData } = useQuery<{ items: DivergentItem[]; count: number }>({
    queryKey: ["divergent-fields"],
    queryFn: async () => {
      const r = await fetch("/api/fundamentals/divergent", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: isAdmin,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });
  const divergentItems = divergentData?.items ?? [];
  const reviewByField = useMemo(() => {
    const grouped = new Map<string, DivergentItem[]>();
    for (const item of divergentItems) {
      const rows = grouped.get(item.field) ?? [];
      rows.push(item);
      grouped.set(item.field, rows);
    }
    return [...grouped.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  }, [divergentItems]);


  const { data, isLoading, isError, refetch } = useQuery<StockDBEntry[]>({
    queryKey: ["admin-stock-db"],
    queryFn: async () => {
      const r = await fetch("/api/fundamentals/stock-db", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });
  const repMutation = useMutation({
    mutationFn: async ({ ticker, peerRep }: { ticker: string; peerRep: boolean }) => {
      const r = await fetch("/api/fundamentals/peer-rep", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, peerRep }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json() as Promise<{ ticker: string; peerRep: boolean }>;
    },
    onMutate: async ({ ticker, peerRep }) => {
      await qc.cancelQueries({ queryKey: ["admin-stock-db"] });
      const prev = qc.getQueryData<StockDBEntry[]>(["admin-stock-db"]);
      qc.setQueryData<StockDBEntry[]>(["admin-stock-db"], old =>
        old?.map(e => e.ticker === ticker ? { ...e, isPeerRep: peerRep } : e),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["admin-stock-db"], ctx.prev);
    },
  });

  const suspectCount = useMemo(() => {
    if (!data) return 0;
    let n = 0;
    for (const row of data) {
      for (const col of COLS) {
        const raw = row.fundamentals?.[col.key];
        if (raw != null && isSuspect(col, String(raw))) n++;
      }
    }
    return n;
  }, [data]);

  // On first data load: collapse all sectors + groups (headers live under each expanded sector)
  useEffect(() => {
    if (!data || _persist.groupsInitialized) return;
    const allGroupIds = new Set(data.filter(e => e.peerGroupId).map(e => e.peerGroupId!));
    const allSectorIds = new Set(
      [...allGroupIds].map(id => id.split(".")[0]).concat("__unclassified"),
    );
    _persist.collapsedGroups = allGroupIds;
    _persist.collapsedSectors = allSectorIds;
    _persist.groupsInitialized = true;
    setCollapsedGroups(new Set(allGroupIds));
    setCollapsedSectors(new Set(allSectorIds));
  }, [data]);

  const provTicker = activeCell?.ticker ?? null;
  const { data: provData, isError: provError, refetch: refetchProv } = useQuery<ProvenanceData>({
    queryKey: ["provenance", provTicker],
    queryFn: async ({ signal }) => {
      const r = await fetch(`/api/fundamentals/provenance/${provTicker}`, { credentials: "include", signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!provTicker && isAdmin,
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
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

  // Provenance/override editing is admin-only (backed by requireAdmin routes), but the
  // suspect/discrepancy flag popup (tooltipParts) is plain client-side info anyone can see —
  // so non-admins still get a click popup when a cell has flags, just without the edit UI.
  const openCell = useCallback((ticker: string, field: string, e: React.MouseEvent<HTMLElement>, tooltipParts: string[], tone?: "good" | "mid" | "bad", z?: number) => {
    if (!isAdmin && tooltipParts.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setActiveCell({ ticker, field, rect, tooltipParts, tone, z });
    setOverrideSrc(activeProv?.override?.source ?? "");
    setOverrideVal(activeProv?.override?.value != null ? String(activeProv.override.value) : "");
    setOverrideNote(activeProv?.override?.note ?? "");
  }, [activeProv, isAdmin]);

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
        if (sortCol === "marketCap") {
          const aVal = a.marketCap;
          const bVal = b.marketCap;
          if (aVal == null && bVal == null) return 0;
          if (aVal == null) return 1;
          if (bVal == null) return -1;
          return sortDir === "asc" ? aVal - bVal : bVal - aVal;
        }
        if (sortCol === "peerRep") {
          const cmp = Number(a.isPeerRep) - Number(b.isPeerRep);
          if (cmp !== 0) return sortDir === "asc" ? cmp : -cmp;
          return a.ticker.localeCompare(b.ticker);
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
      if (a.isPeerRep !== b.isPeerRep) return a.isPeerRep ? -1 : 1;
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
      const groupList = [...groups.entries()].map(([groupId, entries]) => {
        const sortedEntries = entries.sort(sortFn);
        const coverage = calcCoverage(sortedEntries);
        return {
          groupId,
          groupName: entries[0]?.peerGroupName ?? groupId.split(".")[1] ?? groupId,
          entries: sortedEntries,
          coverage,
          count: entries.length,
        };
      });
      // Sort by total filled cells (coverage% × count) so large well-covered groups rank above tiny 100%-coverage groups
      groupList.sort((a, b) => (b.coverage * b.count) - (a.coverage * a.count) || b.count - a.count);
      const allEntries = groupList.flatMap(g => g.entries);
      return { sectorId, label: formatSector(sectorId), groups: groupList, coverage: calcCoverage(allEntries), count: allEntries.length, famCov: famCovFor(allEntries) };
    });
    sectorList.sort((a, b) => b.count - a.count);

    const rows: DisplayRow[] = [];
    let ri = 0;

    for (const sector of sectorList) {
      rows.push({ kind: "sector", sectorId: sector.sectorId, label: sector.label, count: sector.count, coverage: sector.coverage, famCov: sector.famCov });
      for (const group of sector.groups) {
        rows.push({ kind: "group", sectorId: sector.sectorId, groupId: group.groupId, groupName: group.groupName, count: group.entries.length, coverage: group.coverage, entries: group.entries });
        for (const entry of group.entries) {
          rows.push({ kind: "row", sectorId: sector.sectorId, groupId: group.groupId, entry, ri: ri++ });
        }
      }
    }

    if (unclassified.length > 0) {
      const unc = unclassified.sort(sortFn);
      const uncCov = calcCoverage(unc);
      rows.push({ kind: "sector", sectorId: "__unclassified", label: "Unclassified", count: unc.length, coverage: uncCov, famCov: famCovFor(unc) });
      rows.push({ kind: "group", sectorId: "__unclassified", groupId: "__unclassified", groupName: "No peer group", count: unc.length, coverage: uncCov, entries: unc });
      for (const entry of unc) {
        rows.push({ kind: "row", sectorId: "__unclassified", groupId: "__unclassified", entry, ri: ri++ });
      }
    }

    return rows;
  }, [data, tickerFilter, sortCol, sortDir]);

  // Per-column, per-peer-group modified z-scores for statistical outlier detection.
  // Keyed as groupId → colKey → Map<ticker, zScore>.
  const zScoreMap = useMemo(() => {
    const result = new Map<string, Map<string, Map<string, number>>>();
    const byGroup = new Map<string, StockDBEntry[]>();
    for (const e of data ?? []) {
      const gid = e.peerGroupId ?? "__unclassified";
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid)!.push(e);
    }
    for (const [gid, entries] of byGroup) {
      const colMap = new Map<string, Map<string, number>>();
      for (const col of COLS) {
        const scores = computeGroupZScores(entries, col.key, LOG_TRANSFORM_COLS.has(col.key as string));
        if (scores.size > 0) colMap.set(col.key as string, scores);
      }
      if (colMap.size > 0) result.set(gid, colMap);
    }
    return result;
  }, [data]);

  // Good / mid / bad vs the other names in the same sub-sector. Direction depends on the column.
  const toneMap = useMemo(() => {
    const result = new Map<string, Map<string, Map<string, "good" | "mid" | "bad">>>();
    const byGroup = new Map<string, StockDBEntry[]>();
    for (const e of data ?? []) {
      const gid = e.peerGroupId ?? "__unclassified";
      if (!byGroup.has(gid)) byGroup.set(gid, []);
      byGroup.get(gid)!.push(e);
    }
    const keys = [...HIGHER_IS_BETTER, ...LOWER_IS_BETTER];
    for (const [gid, entries] of byGroup) {
      const colMap = new Map<string, Map<string, "good" | "mid" | "bad">>();
      for (const key of keys) {
        const higher = HIGHER_IS_BETTER.has(key);
        const lossBad = NEGATIVE_IS_BAD.has(key);
        const col = COLS.find(c => c.key === key);
        const pairs: { ticker: string; v: number }[] = [];
        for (const e of entries) {
          const raw = e.fundamentals?.[key as keyof NonNullable<StockDBEntry["fundamentals"]>];
          if (raw == null) continue;
          const s = String(raw);
          if (col && (isSuspect(col, s) || isNearZeroBase(col, s))) continue;
          const v = parseFloat(s);
          if (isFinite(v)) pairs.push({ ticker: e.ticker, v });
        }
        const pool = lossBad ? pairs.filter(p => p.v >= 0).map(p => p.v) : pairs.map(p => p.v);
        const tones = new Map<string, "good" | "mid" | "bad">();
        for (const p of pairs) {
          const tone = lossBad && p.v < 0 ? "bad" : metricTone(p.v, pool, higher);
          if (tone) tones.set(p.ticker, tone);
        }
        if (tones.size > 0) colMap.set(key, tones);
      }
      if (colMap.size > 0) result.set(gid, colMap);
    }
    return result;
  }, [data]);

  if (isLoading) return (
    <div className="flex items-center justify-center h-48">
      <Loader2 className="h-6 w-6 animate-spin text-amber-200/40" />
    </div>
  );

  if (isError || !data) return (
    <div className="flex flex-col items-center gap-3 h-48 justify-center text-sm text-amber-200/50">
      <AlertTriangle className="h-6 w-6 text-red-400" />
      Failed to load stock DB.
      <button onClick={() => refetch()} className="text-xs px-3 py-1 border border-[#d4af37]/20 rounded-md hover:text-white">Retry</button>
    </div>
  );

  const nullCount  = data.reduce((acc, row) => acc + COLS.filter(c => row.fundamentals?.[c.key] == null).length, 0);
  const totalCells = data.length * COLS.length;
  const coverage   = totalCells > 0 ? Math.round((1 - nullCount / totalCells) * 100) : 0;
  const visibleRows = displayData.filter(r => r.kind === "row").length;

  return (
    <>
    <div className="space-y-1">
      <StockDbSummaryBar
        data={data}
        coverage={coverage}
        enrichChip={isAdmin ? enrichChip?.text ?? null : null}
        enrichTitle={isAdmin ? enrichChip?.title ?? null : null}
        reviewCount={isAdmin ? divergentItems.length : null}
        suspectCount={isAdmin ? suspectCount : null}
      />

      {/* Vendor + Needs Review on one compact row */}
      {isAdmin && (
        <div className="flex gap-1 items-stretch">
          <div className="flex-1 min-w-0">
            <VendorCrossCheckPanel
              queuePending={queueRefetchMutation.isPending}
              onQueueRefetch={(v) => queueRefetchMutation.mutate(v)}
            />
          </div>
          {divergentItems.length > 0 && (
            <div className="flex-1 min-w-0 rounded-md border border-orange-500/30 overflow-hidden bg-zinc-950">
              <button
                onClick={() => setReviewExpanded(v => !v)}
                className="w-full flex items-center gap-1.5 px-2 py-0.5 text-xs hover:bg-orange-500/10 transition-colors"
              >
                {reviewExpanded ? <ChevronDown className="h-3 w-3 text-orange-300 shrink-0" /> : <ChevronRight className="h-3 w-3 text-orange-300 shrink-0" />}
                <TriangleAlert className="h-3 w-3 text-orange-300 shrink-0" />
                <span className="font-semibold text-white uppercase tracking-wide text-[11px]">Needs Review</span>
                <span className="text-[10px] font-semibold px-1 py-0 rounded border bg-orange-500/25 text-orange-200 border-orange-400/50">
                  {divergentItems.length}
                </span>
                <span className="text-white/80 truncate">sign flip or 3×</span>
              </button>
              {reviewExpanded && (
                <div className="border-t border-[#d4af37]/20 overflow-auto max-h-64">
                  <table className="text-xs w-full border-collapse">
                    <thead className="sticky top-0 bg-black text-[#d4af37]">
                      <tr className="border-b border-[#d4af37]/25">
                        <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2 py-0.5">Field</th>
                        <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2 py-0.5">Count</th>
                        <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2 py-0.5">Tickers</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {reviewByField.map(([field, items]) => (
                        <tr key={field} className="bg-zinc-900/70 even:bg-zinc-800/60">
                          <td className="px-2 py-0.5 font-mono text-amber-100">{field}</td>
                          <td className="px-2 py-0.5 text-right font-mono tabular-nums text-white">{items.length}</td>
                          <td className="px-2 py-0.5 font-mono text-amber-100">
                            {items.slice(0, 8).map(item => (
                              <button
                                key={item.ticker}
                                onClick={e => openCell(item.ticker, item.field, e, [`Needs Review: sign flip or 3× on ${item.field}`])}
                                className="mr-1.5 hover:text-white"
                              >
                                {item.ticker}
                              </button>
                            ))}
                            {items.length > 8 ? <span className="text-white">+{items.length - 8}</span> : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {isAdmin && (refetchQueue.length > 0 || queueRunResult) && (
        <div className="rounded-md border border-sky-500/30 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
          <button
            onClick={() => setQueueExpanded(v => !v)}
            className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-amber-500/5 transition-colors"
          >
            <div className="flex items-center gap-2">
              {queueExpanded ? <ChevronDown className="h-3 w-3 text-amber-200/40" /> : <ChevronRight className="h-3 w-3 text-amber-200/40" />}
              <RefreshCw className="h-3 w-3 text-sky-400" />
              <span className="font-semibold text-sky-300/90 uppercase tracking-wide text-[11px]">Refetch Queue</span>
              {refetchQueue.length > 0 && (
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-sky-500/15 text-sky-400 border-sky-500/30">
                  {refetchQueue.length}
                </span>
              )}
            </div>
            {queueRunResult && (
              <span className="text-amber-200/40">
                last run: {queueRunResult.ok} ok, {queueRunResult.failed} failed
              </span>
            )}
          </button>
          {queueExpanded && (
            <div className="border-t border-[#d4af37]/20">
              {refetchQueue.length > 0 && (
                <div className="overflow-auto max-h-64">
                  <table className="text-xs w-full border-collapse">
                    <thead className="sticky top-0 bg-black text-[#d4af37]">
                      <tr className="border-b border-[#d4af37]/25">
                        <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Ticker</th>
                        <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Field</th>
                        <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Source</th>
                        <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Status</th>
                        <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {refetchQueue.map(item => (
                        <tr key={item.id} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                          <td className="px-2.5 py-1 font-mono font-semibold text-white">{item.ticker}</td>
                          <td className="px-2.5 py-1 font-mono text-amber-200/50">{item.field}</td>
                          <td className="px-2.5 py-1 text-amber-200/50">{item.source}</td>
                          <td className="px-2.5 py-1 text-amber-200/50">{item.status}</td>
                          <td className="px-2.5 py-1 text-right">
                            {item.status === "pending" && (
                              <button
                                onClick={() => removeQueueItemMutation.mutate(item.id)}
                                className="text-[10px] px-2 py-0.5 border border-[#d4af37]/20 rounded hover:text-white text-amber-200/50 transition-colors"
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="px-3 py-2 flex items-center gap-2">
                <button
                  disabled={refetchQueue.filter(i => i.status === "pending").length === 0 || runQueueMutation.isPending}
                  onClick={() => runQueueMutation.mutate()}
                  className="text-[10px] font-semibold px-3 py-1 rounded bg-[#d4af37] text-black disabled:opacity-40 hover:bg-[#d4af37]/90"
                >
                  {runQueueMutation.isPending ? "Running…" : "Run now"}
                </button>
                {runQueueMutation.isError && (
                  <span className="text-[10px] text-red-400">Run failed — see server log</span>
                )}
              </div>
              {/* Completed items vanish from the live queue table above the instant they
                  finish (GET only returns pending/running rows), so this is the only place
                  a per-item done/failed result is visible. Cleared on the next run. */}
              {queueRunResult && queueRunResult.items.length > 0 && (
                <div className="border-t border-[#d4af37]/20 px-3 py-2">
                  <div className="text-[10px] text-amber-200/40 uppercase tracking-wide mb-1">Last run results</div>
                  <div className="flex flex-col gap-0.5 max-h-40 overflow-auto">
                    {queueRunResult.items.map((item, i) => (
                      <div key={i} className="flex items-center gap-1.5 text-[10px] font-mono">
                        <span className={item.status === "done" ? "text-green-400" : "text-red-400"}>
                          {item.status === "done" ? "✓" : "✗"}
                        </span>
                        <span className="font-semibold text-white">{item.ticker}</span>
                        <span className="text-amber-200/40">{item.field}</span>
                        <span className="text-amber-200/40">via {item.source}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* View toggle + filter + legend */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-0.5 p-px bg-zinc-950 border border-[#d4af37]/20 rounded-md w-fit text-[11px] font-semibold">
          {([
            { id: "fundamentals" as const, label: "Fundamentals" },
            { id: "technicals" as const, label: "Technicals" },
            { id: "peers" as const, label: "Peers" },
          ]).map(mode => (
            <button
              key={mode.id}
              onClick={() => setViewMode(mode.id)}
              className={cn(
                "px-2 py-0.5 rounded transition-colors",
                viewMode === mode.id
                  ? "bg-[#d4af37] text-black"
                  : "text-white/90 hover:text-white",
              )}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {viewMode !== "peers" && (
          <div className="flex items-center gap-4">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-amber-100 pointer-events-none" />
              <input
                type="text"
                value={tickerFilter}
                onChange={e => setTickerFilter(e.target.value)}
                placeholder="Filter tickers…"
                className="pl-6 pr-3 py-1 text-xs bg-zinc-950 border border-[#d4af37]/20 text-white placeholder:text-amber-100 rounded-md focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50 w-44"
              />
              {tickerFilter && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-amber-100 tabular-nums">
                  {visibleRows}/{data.length}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-3 text-[10px] text-amber-100">
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-amber-400/70" /> Suspect</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-sky-400/70" /> Override</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5 bg-fuchsia-400/70" /> Agent</span>
              <span className="flex items-center gap-1"><span className="text-[9px] font-normal text-sky-400/80">rep</span> Watchlist</span>
            </div>
          </div>
        )}
      </div>

      {viewMode === "peers" ? (
        <PeerGroupsTab />
      ) : (
      /* Grid — fixed col widths; pad slots keep expand/collapse from resizing */
      <div className="rounded-md border border-[#d4af37]/25 overflow-auto max-h-[calc(100dvh-11rem)] bg-zinc-950">
        <table
          className="text-[11px] leading-none border-collapse table-fixed"
          style={viewMode === "fundamentals" ? { width: fundTableW, minWidth: fundTableW } : undefined}
        >
          {viewMode === "fundamentals" && (
            <colgroup>
              <col style={{ width: COL_W.ticker }} />
              <col style={{ width: COL_W.mcap }} />
              <col style={{ width: COL_W.rep }} />
              {fundCols.map((vc, i) => (
                <col key={vc.kind === "score" ? `s-${vc.id}` : `f-${String(vc.col.key)}-${i}`} style={{ width: vc.kind === "score" ? COL_W.score : COL_W.field }} />
              ))}
              {Array.from({ length: widthPadCols }, (_, i) => (
                <col key={`pad-${i}`} style={{ width: COL_W.field }} />
              ))}
            </colgroup>
          )}
          <thead className="sticky top-0 z-20 bg-zinc-950 text-white">
            <tr>
              <th
                className="sticky left-0 z-30 bg-zinc-950 border-b border-r border-[#d4af37]/30 px-1.5 py-1 text-left font-semibold text-[12px] uppercase tracking-wide cursor-pointer hover:bg-zinc-800 select-none text-[#d4af37]"
                style={{ width: COL_W.ticker, minWidth: COL_W.ticker }}
                onClick={() => handleSort("ticker")}
              >
                <span className="inline-flex items-center gap-0.5">
                  Ticker
                  <SortIcon colKey="ticker" sortCol={sortCol} sortDir={sortDir} />
                </span>
              </th>
              <th
                className="sticky z-30 bg-zinc-950 border-b border-r border-[#d4af37]/30 px-1 py-1 text-right font-semibold text-[11px] uppercase tracking-wide cursor-pointer hover:bg-zinc-800 select-none text-[#d4af37]"
                style={{ left: COL_W.ticker, width: COL_W.mcap, minWidth: COL_W.mcap }}
                onClick={() => handleSort("marketCap")}
                title="Latest close × shares outstanding"
              >
                <span className="inline-flex items-center gap-0.5">
                  Mkt
                  <SortIcon colKey="marketCap" sortCol={sortCol} sortDir={sortDir} />
                </span>
              </th>
              <th
                className="sticky z-30 bg-zinc-950 border-b border-r border-[#d4af37]/30 px-0.5 py-1 text-center font-semibold text-[11px] uppercase tracking-wide cursor-pointer hover:bg-zinc-800 select-none text-[#d4af37]"
                style={{ left: COL_W.ticker + COL_W.mcap, width: COL_W.rep, minWidth: COL_W.rep }}
                onClick={() => handleSort("peerRep")}
                title="Gold ticker. The checkbox is this mark. Display only — does not change the score."
              >
                <span className="inline-flex items-center gap-0.5">
                  Rep
                  <SortIcon colKey="peerRep" sortCol={sortCol} sortDir={sortDir} />
                </span>
              </th>
              {viewMode === "fundamentals"
                ? <>
                  {fundCols.map((vc, i) => {
                  if (vc.kind === "score") {
                    const sortKey = vc.key as string | null;
                    const isOpen = vc.expandable && expandedFamily === vc.id;
                    return (
                      <th
                        key={`score-${vc.id}`}
                        onClick={() => {
                          if (vc.expandable) toggleFamilyExpand(vc.id as FundFamily);
                          else if (sortKey) handleSort(sortKey);
                        }}
                        title={
                          vc.id === "total"
                            ? "Fund total (company blend of V/G/Q/S + sector). Click family headers to expand fields."
                            : vc.expandable
                              ? (isOpen ? `Collapse ${vc.label} fields` : `Expand ${vc.label} fields`)
                              : undefined
                        }
                        className={cn(
                          "border-b border-[#d4af37]/30 text-center px-0.5 py-1.5 text-[12px] font-bold cursor-pointer select-none align-bottom overflow-hidden",
                          i < fundColCount - 1 && "border-r border-black/20",
                          FAMILY_SOLID[vc.family] ?? "bg-zinc-700 text-white",
                          isOpen && "ring-1 ring-inset ring-white/40",
                        )}
                      >
                        <div className="flex flex-col items-center gap-0.5 leading-snug">
                          <span className="inline-flex items-center gap-0.5 whitespace-nowrap">
                            {vc.expandable && (
                              isOpen
                                ? <ChevronDown className="h-3 w-3 opacity-80" />
                                : <ChevronRight className="h-3 w-3 opacity-60" />
                            )}
                            {vc.label}
                            {sortKey && (
                              <span
                                onClick={(e) => { e.stopPropagation(); handleSort(sortKey); }}
                                className="inline-flex"
                              >
                                <SortIcon colKey={sortKey} sortCol={sortCol} sortDir={sortDir} />
                              </span>
                            )}
                          </span>
                        </div>
                      </th>
                    );
                  }
                  const col = vc.col;
                  const cov = colCoverage[col.key as string];
                  const pct = cov && cov.total > 0 ? Math.round((cov.filled / cov.total) * 100) : 0;
                  const lines = headerLines(col.label);
                  const role = vc.asInput ? "input" : colRole(col.key as string);
                  const roleNote = vc.asInput
                    ? `Input to the ratio beside it. ${COL_ROLE_NOTE[col.key as string] ?? "The fund score may also read this column under its own family."}`
                    : (COL_ROLE_NOTE[col.key as string] ?? (role === "input"
                      ? "Input. The fund score does not read this column. A scored ratio is built from it."
                      : "Score. The fund score reads this column."));
                  return (
                    <th
                      key={col.key as string}
                      onClick={() => handleSort(col.key as string)}
                      title={[cov ? `${cov.filled}/${cov.total} filled` : "", roleNote].filter(Boolean).join(" · ")}
                      className={cn(
                        "border-b border-[#d4af37]/30 text-center px-0.5 py-1.5 text-[11px] font-normal cursor-pointer hover:bg-zinc-800/80 select-none align-bottom overflow-hidden",
                        i < fundColCount - 1 && "border-r border-[#d4af37]/10",
                        FAMILY_COLORS[col.family],
                        FAMILY_LABEL[col.family] ?? "text-white",
                      )}
                    >
                      <div className="flex flex-col items-center gap-0.5 leading-snug">
                        <span className="inline-flex flex-col items-center font-normal">
                          {lines.map((line, li) => (
                            <span key={li} className="whitespace-nowrap inline-flex items-center gap-0.5">
                              {line}
                              {li === lines.length - 1 && (
                                <SortIcon colKey={col.key as string} sortCol={sortCol} sortDir={sortDir} />
                              )}
                            </span>
                          ))}
                        </span>
                        {cov && (
                          <span className={cn("text-[10px] font-normal tabular-nums", coverageColor(pct))}>{pct}%</span>
                        )}
                        <span className={cn("text-[9px] uppercase tracking-wide", role === "input" ? "text-amber-200/70" : "text-sky-300/80")}>
                          {role === "input" ? "input" : "score"}
                        </span>
                      </div>
                    </th>
                  );
                })}
                  {Array.from({ length: widthPadCols }, (_, i) => (
                    <th key={`pad-h-${i}`} className="border-b border-[#d4af37]/30 p-0 bg-zinc-950" aria-hidden />
                  ))}
                </>
                : TECH_COLS.map((col, i) => {
                  const lines = headerLines(col.label);
                  return (
                    <th
                      key={col.key as string}
                      className={cn(
                        "border-b border-[#d4af37]/30 text-center px-0.5 py-1.5 text-[12px] font-semibold",
                        i < TECH_COLS.length - 1 && "border-r border-[#d4af37]/10",
                        TECH_FAMILY_COLORS[col.family],
                      )}
                    >
                      <span className="inline-flex flex-col items-center leading-snug">
                        {lines.map((line, li) => (
                          <span key={li} className="whitespace-nowrap">{line}</span>
                        ))}
                      </span>
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
                const colSpan = (viewMode === "fundamentals" ? fundColCount : TECH_COLS.length) + 3;
                const isFirstSector = !displayData.slice(0, idx).some((x) => x.kind === "sector");
                return (
                  <Fragment key={`sector-${item.sectorId}`}>
                  {!isFirstSector && (
                    <tr key={`gap-${item.sectorId}`} aria-hidden>
                      <td colSpan={colSpan} className="h-3 p-0 border-0 bg-zinc-950" />
                    </tr>
                  )}
                  <tr
                    key={`sector-${item.sectorId}`}
                    className="cursor-pointer select-none"
                    onClick={() => toggleSector(item.sectorId)}
                  >
                    <td colSpan={colSpan} className={cn("p-0 border-l-4", pal.border)}>
                      <div className={cn("flex items-center gap-2 px-2 py-1", pal.bg)}>
                        {isCollapsed
                          ? <ChevronRight className={cn("h-3.5 w-3.5 flex-shrink-0", pal.chevron)} />
                          : <ChevronDown  className={cn("h-3.5 w-3.5 flex-shrink-0", pal.chevron)} />
                        }
                        <span className={cn("font-bold text-[12px] uppercase tracking-widest", pal.text)}>{item.label}</span>
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-semibold tabular-nums", pal.badge)}>{item.count} tickers</span>
                        <div className="flex items-center gap-1">
                          {families.map(fam => {
                            const fc = item.famCov[fam];
                            if (!fc || fc.total === 0) return null;
                            const pct = Math.round((fc.filled / fc.total) * 100);
                            return (
                              <span
                                key={fam}
                                className={cn(
                                  "text-[10px] px-1.5 py-px rounded font-semibold tabular-nums",
                                  FAMILY_CHIP[fam] ?? "bg-zinc-600 text-white",
                                )}
                                title={`${fam} coverage across this sector, ${pct}%`}
                              >
                                {fam[0].toUpperCase()} {pct}%
                              </span>
                            );
                          })}
                        </div>
                        <div className="ml-auto flex items-center gap-2.5">
                          <div className="w-20 h-1.5 rounded-full bg-black/60 overflow-hidden">
                            <div className={cn("h-full rounded-full", coverageBarColor(item.coverage))} style={{ width: `${item.coverage}%` }} />
                          </div>
                          <span className={cn("text-[11px] font-semibold tabular-nums w-10 text-right", coverageColor(item.coverage))}>
                            {item.coverage}%
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                  </Fragment>
                );
              }

              // ── Group header ───────────────────────────────────────────────
              if (item.kind === "group") {
                if (collapsedSectors.has(item.sectorId)) return null;
                const isCollapsed = collapsedGroups.has(item.groupId);
                const pal = getSectorPalette(item.sectorId);
                return (
                  <Fragment key={`group-${item.groupId}-${idx}`}>
                  <tr
                    key={`group-${item.groupId}-${idx}`}
                    className="cursor-pointer select-none hover:bg-[#d4af37]/10 transition-colors border-b border-zinc-800"
                    onClick={() => toggleGroup(item.groupId)}
                  >
                    <td colSpan={(viewMode === "fundamentals" ? fundColCount : TECH_COLS.length) + 3} className={cn("p-0 border-l-4", pal.border)}>
                      <div className="flex items-center gap-1.5 pl-6 pr-2 py-1 bg-zinc-900">
                        {isCollapsed
                          ? <ChevronRight className="h-3 w-3 text-[#d4af37] flex-shrink-0" />
                          : <ChevronDown  className="h-3 w-3 text-[#d4af37] flex-shrink-0" />
                        }
                        <span className="text-[11px] font-semibold text-white tracking-wide">{item.groupName}</span>
                        <span className="text-[10px] text-amber-100 tabular-nums">{item.count}</span>
                        <div className="ml-auto flex items-center gap-2">
                          <div className="w-16 h-1 rounded-full bg-black/60 overflow-hidden">
                            <div className={cn("h-full rounded-full", coverageBarColor(item.coverage))} style={{ width: `${item.coverage}%` }} />
                          </div>
                          <span className={cn("text-[11px] tabular-nums w-8 text-right font-semibold", coverageColor(item.coverage))}>
                            {item.coverage}%
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                  {!isCollapsed && viewMode === "fundamentals" && (["med", "avg"] as const).map(kind => (
                    <tr key={`${kind}-${item.groupId}-${idx}`} className="border-b border-zinc-800 bg-zinc-900">
                      <td
                        className={cn("sticky left-0 z-10 border-r border-zinc-800 bg-zinc-900 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide", pal.num)}
                        style={{ width: COL_W.ticker, minWidth: COL_W.ticker }}
                        title={kind === "med"
                          ? "Median of this group. Blanks, invalid values, and growth rates off a near-zero base are left out."
                          : "Average after dropping those same blanks, plus the statistical outliers this grid marks (|z| > 3)."}
                      >
                        {kind}
                      </td>
                      <td
                        className="sticky z-10 border-r border-zinc-800 bg-zinc-900"
                        style={{ left: COL_W.ticker, width: COL_W.mcap, minWidth: COL_W.mcap }}
                      />
                      <td
                        className="sticky z-10 border-r border-zinc-800 bg-zinc-900"
                        style={{ left: COL_W.ticker + COL_W.mcap, width: COL_W.rep, minWidth: COL_W.rep }}
                      />
                      {fundCols.map((vc, ci) => {
                        const scoreVals = vc.kind === "score" && vc.key
                          ? item.entries.map(e => {
                              const raw = e.fundamentals?.[vc.key!];
                              return raw != null ? parseFloat(String(raw)) : NaN;
                            }).filter(n => isFinite(n))
                          : [];
                        const value = vc.kind === "score"
                          ? (kind === "med" ? numericMedian(scoreVals) : trimmedMean(scoreVals, false))
                          : (kind === "med"
                            ? groupMedian(item.entries, vc.col)
                            : groupTrimmedMean(item.entries, vc.col, LOG_TRANSFORM_COLS.has(vc.col.key as string)));
                        const text = value == null ? "—" : vc.kind === "score" ? value.toFixed(0) : fmt(String(value), vc.col.fmt);
                        return (
                          <td
                            key={`${kind}-${vc.kind === "score" ? vc.id : vc.col.key as string}`}
                            className={cn(
                              "px-1 py-0.5 text-center font-mono tabular-nums text-[11px] font-semibold",
                              pal.num,
                              ci < fundColCount - 1 && "border-r border-zinc-800/60",
                            )}
                            title={value == null ? "No usable values" : (kind === "med" ? "Median" : "Outlier-excluded average")}
                          >
                            {text}
                          </td>
                        );
                      })}
                      {Array.from({ length: widthPadCols }, (_, i) => (
                        <td key={`${kind}-pad-${i}`} className="p-0" aria-hidden />
                      ))}
                    </tr>
                  ))}
                </Fragment>
                );
              }

              // ── Data row ───────────────────────────────────────────────────
              if (collapsedSectors.has(item.sectorId) || collapsedGroups.has(item.groupId)) return null;

              const { entry: row } = item;
              const f = row.fundamentals;

              return (
                <tr
                  key={row.ticker}
                  className={cn(
                    "group border-b border-zinc-800/80 transition-colors",
                    "hover:bg-[#d4af37]/12",
                    row.isPeerRep && "border-l-2 border-l-[#d4af37]",
                  )}
                >
                  {/* Ticker — sticky; checked rep = gold fill */}
                  <td
                    className={cn(
                      "sticky left-0 z-10 border-r border-zinc-800 px-1.5 py-0.5 font-mono whitespace-nowrap",
                      row.isPeerRep
                        ? "bg-[#d4af37] text-black group-hover:bg-[#e0c04a]"
                        : "bg-zinc-950 group-hover:bg-[#2a2618]",
                    )}
                    style={{ width: COL_W.ticker, minWidth: COL_W.ticker }}
                  >
                    <div className="flex items-center gap-1">
                      <span className={row.isPeerRep ? "font-semibold text-black" : "text-white"}>{row.ticker}</span>
                      {!f && (
                        <span className="text-[9px] leading-none font-normal text-amber-100/70">no data</span>
                      )}
                    </div>
                  </td>
                  <td
                    className="sticky z-10 border-r border-zinc-800 px-1 py-0.5 text-right font-mono tabular-nums text-white/90 bg-zinc-950 group-hover:bg-[#2a2618]"
                    style={{ left: COL_W.ticker, width: COL_W.mcap, minWidth: COL_W.mcap }}
                    title={row.marketCap != null ? formatCompactCurrency(row.marketCap) : "No close or share count"}
                  >
                    {formatCompactCurrency(row.marketCap)}
                  </td>
                  <td
                    className="sticky z-10 border-r border-zinc-800 px-0.5 py-0.5 text-center bg-zinc-950 group-hover:bg-[#2a2618]"
                    style={{ left: COL_W.ticker + COL_W.mcap, width: COL_W.rep, minWidth: COL_W.rep }}
                  >
                    <input
                      type="checkbox"
                      checked={row.isPeerRep}
                      disabled={!isAdmin}
                      title={row.isPeerRep ? "Gold ticker. Uncheck to clear it. Does not change the score." : "Mark as a gold ticker. Does not change the score."}
                      onClick={e => e.stopPropagation()}
                      onChange={() => repMutation.mutate({ ticker: row.ticker, peerRep: !row.isPeerRep })}
                      className="h-3 w-3 accent-[#d4af37] cursor-pointer disabled:cursor-default"
                    />
                  </td>

                  {/* Score + optional expanded family fields */}
                  {viewMode === "fundamentals" ? <>
                    {fundCols.map((vc, ci) => {
                    if (vc.kind === "score") {
                      const raw = vc.key && f ? (f[vc.key] as string | null) : null;
                      const style = !vc.key && f?.styleBucket ? String(f.styleBucket) : null;
                      const isNull = vc.key ? raw == null : !style;
                      const num = raw != null ? parseFloat(raw) : NaN;
                      const display = vc.key
                        ? (raw == null || Number.isNaN(num) ? "—" : num.toFixed(0))
                        : (style ? style.replace(/_/g, " ").slice(0, 8) : "—");
                      const tone = vc.key
                        ? toneMap.get(row.peerGroupId ?? "__unclassified")?.get(vc.key as string)?.get(row.ticker)
                        : null;
                      return (
                        <td
                          key={`score-${vc.id}-${row.ticker}`}
                          onClick={() => { if (vc.expandable) toggleFamilyExpand(vc.id as FundFamily); }}
                          className={cn(
                            "px-1 py-0.5 text-center font-mono whitespace-nowrap tabular-nums font-bold overflow-hidden",
                            ci < fundColCount - 1 && "border-r border-zinc-800/60",
                            FAMILY_CELL_BG[vc.family],
                            isNull ? "bg-red-600 text-white"
                              : tone === "good" ? "text-emerald-400"
                              : tone === "bad" ? "text-red-400"
                              : tone === "mid" ? "text-yellow-300"
                              : (FAMILY_LABEL[vc.family] ?? "text-white"),
                            vc.expandable && "cursor-pointer",
                            expandedFamily === vc.id && "ring-1 ring-inset ring-white/30",
                          )}
                          title={
                            isNull && vc.key
                              ? "Missing family score"
                              : vc.expandable
                                ? (expandedFamily === vc.id ? "Collapse fields" : "Expand fields")
                                : undefined
                          }
                        >
                          {display}
                        </td>
                      );
                    }
                    const col = vc.col;
                    const raw = f ? (f[col.key] as string | null) : null;
                    const isNull = raw == null;
                    const isOptionalNull = isNull && !!col.optional;
                    const isMissing = isNull && !col.optional;
                    const hardInvalid = isSuspect(col, raw);
                    const z = zScoreMap.get(row.peerGroupId ?? "__unclassified")?.get(col.key as string)?.get(row.ticker);
                    const isStatOutlier = z != null && Math.abs(z) > 3.0;
                    const suspect = hardInvalid || isStatOutlier;
                    const tone = toneMap.get(row.peerGroupId ?? "__unclassified")?.get(col.key as string)?.get(row.ticker);
                    const flags = f?.discrepancyFlags?.split(",") ?? [];
                    const hasFlag = flags.includes(col.key as string);
                    const overrideFlags = f?.overrideFlags?.split(",") ?? [];
                    const hasOverride = overrideFlags.includes(col.key as string);
                    const agentFlags = f?.agentOverrideFlags?.split(",") ?? [];
                    const hasAgent = agentFlags.includes(col.key as string);
                    const isActive = activeCell?.ticker === row.ticker && activeCell?.field === (col.key as string);
                    const justRefetched = justSucceeded.has(`${row.ticker}:${col.key as string}`);
                    const tooltipParts: string[] = [];
                    if (isMissing) tooltipParts.push(`Missing ${col.label} — expected field, no value in DB`);
                    if (hardInvalid) tooltipParts.push(`Suspect: ${col.label} value is structurally invalid (e.g. negative when it shouldn't be)`);
                    const higher = HIGHER_IS_BETTER.has(col.key as string);
                    const lower = LOWER_IS_BETTER.has(col.key as string);
                    const rank = isStatOutlier && z != null && (higher || lower)
                      ? ((higher ? z > 0 : z < 0) ? "good" : "bad")
                      : tone;
                    if (hasFlag) tooltipParts.push(`Needs Review: another source flips the sign or is 3× this ${col.label}`);
                    if (hasAgent) tooltipParts.push(`Database Agent override for ${col.label} — see popup trail`);
                    else if (hasOverride) tooltipParts.push(`Manual override active for ${col.label} — a source other than default priority was picked after review`);
                    return (
                      <td
                        key={col.key as string}
                        onClick={(e) => openCell(row.ticker, col.key as string, e, tooltipParts, rank, z ?? undefined)}
                        className={cn(
                          "px-1 py-0.5 text-center font-mono whitespace-nowrap tabular-nums font-normal overflow-hidden",
                          rank === "good" ? "text-emerald-400" : rank === "bad" ? "text-red-400" : rank === "mid" ? "text-yellow-300" : "text-white/90",
                          (isAdmin || tooltipParts.length > 0) && "cursor-pointer",
                          ci < fundColCount - 1 && "border-r border-zinc-800/60",
                          isActive && "outline outline-1 outline-[#d4af37]/50 -outline-offset-1",
                          isOptionalNull && "text-white/35",
                          isMissing && "bg-red-600 text-white font-semibold",
                          !isNull && suspect && "shadow-[inset_0_-1px_0_0_rgba(251,191,36,0.7)]",
                          !isNull && hasOverride && !hasAgent && "shadow-[inset_0_-1px_0_0_rgba(56,189,248,0.7)]",
                          !isNull && hasAgent && "shadow-[inset_0_-1px_0_0_rgba(232,121,249,0.75)]",
                          !isNull && hasFlag && !suspect && !hasOverride && !hasAgent && "shadow-[inset_0_-1px_0_0_rgba(148,163,184,0.5)]",
                          justRefetched && "text-green-300",
                        )}
                        title={
                          isMissing ? `Missing ${col.label}`
                            : justRefetched ? "Re-fetched successfully"
                              : hasAgent ? "Database Agent override"
                                : undefined
                        }
                      >
                        {isOptionalNull || isNull
                          ? "—"
                          : isNearZeroBase(col, raw)
                            ? <span className="text-white/30" title="Not meaningful — prior period near zero">N/M</span>
                            : fmt(raw, col.fmt)}
                      </td>
                    );
                  })}
                    {Array.from({ length: widthPadCols }, (_, i) => (
                      <td key={`pad-${row.ticker}-${i}`} className="p-0 border-r border-zinc-900/40" aria-hidden />
                    ))}
                  </> : TECH_COLS.map((col, ci) => {
                    const t = row.technicals;
                    const raw = t ? t[col.key] : null;
                    const isNull = raw == null;
                    const regimeColor = col.key === "regime" && !isNull
                      ? raw === "BULLISH" ? "text-green-400" : raw === "BEARISH" ? "text-red-400" : "text-amber-400"
                      : null;
                    const signalColor = col.key === "fallingKnife" && Number(raw) === 1 ? "text-red-400" : null;
                    return (
                      <td
                        key={col.key as string}
                        className={cn(
                          "px-1 py-0.5 text-center font-mono whitespace-nowrap tabular-nums",
                          ci < TECH_COLS.length - 1 && "border-r border-zinc-800/60",
                          isNull ? "text-white/25" : regimeColor ?? signalColor ?? "text-white/80",
                        )}
                      >
                        {isNull ? "—" : col.fmt(raw)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {visibleRows === 0 && tickerFilter && (
              <tr>
                <td colSpan={(viewMode === "fundamentals" ? fundColCount : TECH_COLS.length) + 3} className="py-8 text-center text-amber-200/40 text-xs">
                  No tickers match "{tickerFilter}"
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      )}
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
        className="w-80 p-0 text-xs overflow-y-auto overscroll-contain bg-zinc-950 border border-[#d4af37]/25 shadow-lg shadow-black/60 max-h-[var(--radix-popover-content-available-height)]"
        align="start"
        sideOffset={4}
        collisionPadding={12}
        onWheel={(e) => e.stopPropagation()}
        onInteractOutside={() => setActiveCell(null)}
      >
        {!isAdmin && activeCell && (
          <div className="p-3 flex flex-col gap-1.5">
            <span className="font-semibold text-white">{activeCell.ticker} · {activeCell.field}</span>
            {activeCell.tooltipParts.map((part, i) => (
              <div key={i} className="flex items-start gap-1.5 text-amber-400">
                <TriangleAlert className="h-3 w-3 mt-0.5 flex-shrink-0" />
                <span>{part}</span>
              </div>
            ))}
          </div>
        )}
        {isAdmin && !activeProv && provError && (
          <div className="p-3 flex flex-col gap-2">
            <div className="text-red-400 flex items-center gap-1.5 text-xs">
              <AlertTriangle className="h-3 w-3" /> Couldn't load source detail.
            </div>
            <button
              onClick={() => refetchProv()}
              className="text-[10px] px-2 py-1 border border-[#d4af37]/20 rounded hover:text-white text-amber-200/50 transition-colors self-start"
            >
              Retry
            </button>
          </div>
        )}
        {isAdmin && !activeProv && !provError && (
          <div className="p-3 text-amber-200/40 flex items-center gap-2">
            <Loader2 className="h-3 w-3 animate-spin" /> Loading provenance…
          </div>
        )}
        {isAdmin && activeProv && (
          <div>
            <div className="sticky top-0 z-10 px-3 py-1.5 border-b border-[#d4af37]/20 bg-black/40 flex items-center justify-between gap-2">
              <span className="font-semibold text-white inline-flex items-center gap-1.5">
                {activeCell?.ticker} · {activeCell?.field}
                {activeCell?.tone && (
                  <span
                    title={rankMarkTitle(activeCell.tone, activeCell.z)}
                    className={cn(
                      "inline-block h-2 w-2 rounded-full",
                      activeCell.tone === "good" ? "bg-emerald-400" : activeCell.tone === "bad" ? "bg-red-400" : "bg-yellow-300",
                    )}
                  />
                )}
              </span>
              <div className="flex items-center gap-1">
                {activeProv.isAgentOverride && <span title="Database Agent override" className="text-[9px] px-1 rounded border border-fuchsia-400/50 text-fuchsia-300">agent</span>}
                {activeProv.isOverride && !activeProv.isAgentOverride && <span title="Manual override active"><Pin className="h-3 w-3 text-amber-400" /></span>}
                {activeProv.divergent  && <span title="Sources disagree"><TriangleAlert className="h-3 w-3 text-orange-400" /></span>}
              </div>
            </div>

            {activeProv.isAgentOverride && activeProv.agentNote && (
              <div className="px-3 py-2 border-b border-fuchsia-500/30 bg-fuchsia-500/10 text-[10px] text-fuchsia-100 space-y-0.5">
                <div className="font-semibold text-fuchsia-300 uppercase tracking-wide">Agent trail</div>
                <div className="font-mono break-all whitespace-pre-wrap text-white/90">{activeProv.agentNote}</div>
                {activeProv.override && (
                  <div className="text-white/80">
                    Override source <span className="font-mono text-fuchsia-200">{activeProv.override.source}</span>
                    {activeProv.winningValue != null && <> · gold <span className="font-mono">{activeProv.winningValue.toPrecision(5)}</span></>}
                  </div>
                )}
              </div>
            )}

            {activeCell && activeCell.tooltipParts.length > 0 && (
              <div className="px-3 py-2 border-b border-[#d4af37]/20 flex flex-col gap-1">
                {activeCell.tooltipParts.map((part, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-amber-400">
                    <TriangleAlert className="h-3 w-3 mt-0.5 flex-shrink-0" />
                    <span>{part}</span>
                  </div>
                ))}
              </div>
            )}

            {(DERIVED_INPUTS[activeProv.field]?.length || newerSourceNote(activeProv) || activeProv.divergent) ? (
            <div className="px-3 py-1.5 border-b border-[#d4af37]/20">
              {(DERIVED_INPUTS[activeProv.field] ?? []).map(part => {
                const input = fieldByName(provData, part.field);
                const src = input ? usedSource(input) : null;
                return (
                  <div key={part.field} className="flex items-center justify-between mt-0.5 text-[10px]">
                    <span className="text-amber-200/50">{part.label}</span>
                    <span className="font-mono text-amber-100/80">
                      {input?.winningValue != null ? input.winningValue.toPrecision(4) : "—"}
                      {" · "}{src?.source ?? input?.winningSource ?? "—"}
                      {" · "}{fmtDate(src?.fetchedAt ?? input?.fetchedAt ?? null)}
                    </span>
                  </div>
                );
              })}
              {newerSourceNote(activeProv) && (
                <div className="mt-1.5 text-[10px] text-orange-300">{newerSourceNote(activeProv)}</div>
              )}
              {(DERIVED_INPUTS[activeProv.field] ?? []).map(part => {
                const input = fieldByName(provData, part.field);
                const note = input ? newerSourceNote(input) : null;
                return note ? <div key={`${part.field}-note`} className="mt-1 text-[10px] text-orange-300">{part.label}: {note}</div> : null;
              })}
              {activeProv.divergent && (
                <div className="mt-1.5 text-[10px] text-orange-400 flex items-center gap-1">
                  <TriangleAlert className="h-2.5 w-2.5" /> Sources disagree on this value
                </div>
              )}
            </div>
            ) : null}

            <div className="px-3 py-1.5 border-b border-[#d4af37]/20">
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-amber-200/40 border-b border-[#d4af37]/10">
                    <th className="text-left font-normal pb-0.5">Source</th>
                    <th className="text-right font-normal pb-0.5">Value</th>
                    <th className="text-right font-normal pb-0.5">Age</th>
                    <th className="text-right font-normal pb-0.5">Status</th>
                    <th className="text-right font-normal pb-0.5"></th>
                  </tr>
                </thead>
                <tbody>
                  {activeProv.sources.map(s => {
                    const queued = refetchQueue.some(
                      q => q.ticker === activeCell?.ticker && q.field === activeCell?.field && q.source === s.source
                    );
                    return (
                    <tr key={s.source} className={cn(s.status === "excluded" || s.status === "no_data" ? "text-amber-200/30" : "text-amber-200/70")}>
                      <td className="py-px">{s.source}</td>
                      <td className="text-right font-mono py-px tabular-nums">
                        {s.value != null ? s.value.toPrecision(4) : "—"}
                      </td>
                      <td className="text-right py-px" title={sourceAgeTitle(s)}>{sourceAgeLabel(s)}</td>
                      <td className="text-right py-px">
                        {s.status === "used"      && <span className="text-green-400">used</span>}
                        {s.status === "available" && <span className="text-sky-400">avail</span>}
                        {s.status === "no_data"   && (
                          <span title={s.lastQueriedAt ? "source was queried but had no value for this field" : "this source has never been fetched for this ticker"}>
                            no data
                          </span>
                        )}
                        {s.status === "excluded"  && (
                          <span className="text-amber-200/25" title={s.exclusionReason}>excl</span>
                        )}
                      </td>
                      <td className="text-right py-px pl-1">
                        <button
                          disabled={queued || queueRefetchMutation.isPending}
                          onClick={() => {
                            if (!activeCell) return;
                            queueRefetchMutation.mutate({ ticker: activeCell.ticker, field: activeCell.field, sources: [s.source] });
                          }}
                          className="text-[9px] px-1 py-0.5 border border-[#d4af37]/20 rounded hover:text-white text-amber-200/50 transition-colors disabled:opacity-40 whitespace-nowrap"
                        >
                          {queued ? "queued" : "queue re-fetch"}
                        </button>
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {(activeProv.research?.some(r => r.value != null) ?? false) && (
              <div className="px-3 py-2 border-b border-[#d4af37]/20">
                <div className="text-[10px] font-semibold text-violet-300/90 uppercase tracking-wide mb-1">Research / desk</div>
                <table className="w-full text-[10px]">
                  <thead>
                    <tr className="text-amber-100/80 border-b border-[#d4af37]/10">
                      <th className="text-left font-normal pb-0.5">Source</th>
                      <th className="text-right font-normal pb-0.5">Value</th>
                      <th className="text-right font-normal pb-0.5">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeProv.research!.filter(r => r.value != null).map(r => (
                      <tr key={r.source} className={r.status === "available" ? "text-white/85" : "text-white/35"}>
                        <td className="py-px">{r.source}</td>
                        <td className="text-right font-mono py-px tabular-nums" title={r.note}>
                          {r.value != null ? r.value.toPrecision(4) : "—"}
                        </td>
                        <td className="text-right py-px" title={r.note}>{r.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="px-3 py-2">
              <div className="text-[10px] font-semibold text-[#d4af37]/80 uppercase tracking-wide mb-1.5">
                {activeProv.override ? "Override active" : "Override source"}
              </div>
              <div className="flex flex-col gap-1.5">
                <select
                  value={overrideSrc}
                  onChange={e => { setOverrideSrc(e.target.value); setOverrideVal(""); }}
                  className="w-full text-[10px] bg-zinc-950 text-white border border-[#d4af37]/20 rounded px-1.5 py-1"
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
                    className="w-full text-[10px] bg-zinc-950 text-white placeholder:text-amber-200/30 border border-[#d4af37]/20 rounded px-1.5 py-1 font-mono"
                  />
                )}
                <input
                  type="text"
                  value={overrideNote}
                  onChange={e => setOverrideNote(e.target.value)}
                  placeholder="note (optional)"
                  className="w-full text-[10px] bg-zinc-950 text-white placeholder:text-amber-200/30 border border-[#d4af37]/20 rounded px-1.5 py-1"
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
                    className="flex-1 text-[10px] font-semibold py-1 rounded bg-[#d4af37] text-black disabled:opacity-40 hover:bg-[#d4af37]/90"
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
                      className="flex-1 text-[10px] py-1 rounded border border-[#d4af37]/20 text-amber-200/50 hover:text-white transition-colors disabled:opacity-40"
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
