import { useState, useMemo, useCallback, useEffect, useRef } from "react";
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
  COLS, TECH_COLS, FAMILY_COLORS, TECH_FAMILY_COLORS, techFamilies, LOG_TRANSFORM_COLS, txt, flag,
} from "./stockdb/stock-db-columns";
import { getSectorPalette, coverageColor, coverageBarColor } from "./stockdb/stock-db-palette";
import {
  calcCoverage, fmt, isSuspect, computeGroupZScores, isNearZeroBase, fmtDate, sourceAgeLabel, sourceAgeTitle,
} from "./stockdb/stock-db-formatters";
import { PipelineHealthPanel } from "./stockdb/stock-db-admin-panel";
import { VendorCrossCheckPanel } from "./stockdb/vendor-cross-check-panel";
import { StockDbSummaryBar } from "./stockdb/stock-db-summary-bar";
import { PeerGroupsTab } from "./PeerGroupsTab";

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

type ActiveCell = { ticker: string; field: string; rect: DOMRect; tooltipParts: string[] };

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
  const [pipelineExpanded, setPipelineExpanded] = useState(false);

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
  const runs = runsData?.runs ?? [];
  const latestRun = runs[0] ?? null;

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


  const { data, isLoading, isError, refetch, isFetching } = useQuery<StockDBEntry[]>({
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

  // On first data load: collapse all groups by default, leave sectors expanded
  useEffect(() => {
    if (!data || _persist.groupsInitialized) return;
    const allGroupIds = new Set(data.filter(e => e.peerGroupId).map(e => e.peerGroupId!));
    _persist.collapsedGroups = allGroupIds;
    _persist.groupsInitialized = true;
    setCollapsedGroups(new Set(allGroupIds));
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
  const openCell = useCallback((ticker: string, field: string, e: React.MouseEvent<HTMLElement>, tooltipParts: string[]) => {
    if (!isAdmin && tooltipParts.length === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setActiveCell({ ticker, field, rect, tooltipParts });
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
      const groupList = [...groups.entries()].map(([groupId, entries]) => {
        const sortedEntries = entries.sort(sortFn);
        const coverage = calcCoverage(sortedEntries);
        const famCov: FamilyCovSummary = Object.fromEntries(
          families.map(fam => {
            const famCols = COLS.filter(c => c.family === fam);
            const filled = sortedEntries.reduce((acc, e) => acc + famCols.filter(c => e.fundamentals?.[c.key] != null).length, 0);
            return [fam, { filled, total: sortedEntries.length * famCols.length }];
          })
        );
        return {
          groupId,
          groupName: entries[0]?.peerGroupName ?? groupId.split(".")[1] ?? groupId,
          entries: sortedEntries,
          coverage,
          count: entries.length,
          famCov,
        };
      });
      // Sort by total filled cells (coverage% × count) so large well-covered groups rank above tiny 100%-coverage groups
      groupList.sort((a, b) => (b.coverage * b.count) - (a.coverage * a.count) || b.count - a.count);
      const allEntries = groupList.flatMap(g => g.entries);
      return { sectorId, label: formatSector(sectorId), groups: groupList, coverage: calcCoverage(allEntries), count: allEntries.length };
    });
    sectorList.sort((a, b) => b.count - a.count);

    const rows: DisplayRow[] = [];
    let ri = 0;

    for (const sector of sectorList) {
      rows.push({ kind: "sector", sectorId: sector.sectorId, label: sector.label, count: sector.count, coverage: sector.coverage });
      for (const group of sector.groups) {
        rows.push({ kind: "group", sectorId: sector.sectorId, groupId: group.groupId, groupName: group.groupName, count: group.entries.length, coverage: group.coverage, famCov: group.famCov });
        for (const entry of group.entries) {
          rows.push({ kind: "row", sectorId: sector.sectorId, groupId: group.groupId, entry, ri: ri++ });
        }
      }
    }

    if (unclassified.length > 0) {
      const unc = unclassified.sort(sortFn);
      const uncCov = calcCoverage(unc);
      const uncFamCov: FamilyCovSummary = Object.fromEntries(
        families.map(fam => {
          const famCols = COLS.filter(c => c.family === fam);
          const filled = unc.reduce((acc, e) => acc + famCols.filter(c => e.fundamentals?.[c.key] != null).length, 0);
          return [fam, { filled, total: unc.length * famCols.length }];
        })
      );
      rows.push({ kind: "sector", sectorId: "__unclassified", label: "Unclassified", count: unc.length, coverage: uncCov });
      rows.push({ kind: "group", sectorId: "__unclassified", groupId: "__unclassified", groupName: "No peer group", count: unc.length, coverage: uncCov, famCov: uncFamCov });
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
  const noRow      = data.filter(d => !d.fundamentals).length;
  const visibleRows = displayData.filter(r => r.kind === "row").length;

  return (
    <>
    <div className="space-y-1.5">
      <StockDbSummaryBar
        data={data} noRow={noRow} coverage={coverage} isFetching={isFetching}
        onRefresh={isAdmin ? () => refetch() : undefined}
      />

      {/* Pipeline health */}
      {isAdmin && latestRun && (
        <PipelineHealthPanel
          runs={runs}
          latestRun={latestRun}
          pipelineExpanded={pipelineExpanded}
          setPipelineExpanded={setPipelineExpanded}
        />
      )}

      {/* Vendor cross-check — LSEG gold_audit (read-only; human queues refetch) */}
      {isAdmin && (
        <VendorCrossCheckPanel
          queuePending={queueRefetchMutation.isPending}
          onQueueRefetch={(v) => queueRefetchMutation.mutate(v)}
        />
      )}

      {/* Divergent-field review queue — sources disagree and no admin has overridden yet */}
      {isAdmin && divergentItems.length > 0 && (
        <div className="rounded-md border border-orange-500/30 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
          <button
            onClick={() => setReviewExpanded(v => !v)}
            className="w-full flex items-center justify-between gap-3 px-3 py-2 text-xs hover:bg-amber-500/5 transition-colors"
          >
            <div className="flex items-center gap-2">
              {reviewExpanded ? <ChevronDown className="h-3 w-3 text-amber-200/40" /> : <ChevronRight className="h-3 w-3 text-amber-200/40" />}
              <TriangleAlert className="h-3 w-3 text-orange-400" />
              <span className="font-semibold text-orange-300/90 uppercase tracking-wide text-[11px]">Needs Review</span>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-orange-500/15 text-orange-400 border-orange-500/30">
                {divergentItems.length}
              </span>
            </div>
            <span className="text-amber-200/40">sources disagree — no override set yet</span>
          </button>
          {reviewExpanded && (
            <div className="border-t border-[#d4af37]/20 overflow-auto max-h-64">
              <table className="text-xs w-full border-collapse">
                <thead className="sticky top-0 bg-black text-[#d4af37]">
                  <tr className="border-b border-[#d4af37]/25">
                    <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Ticker</th>
                    <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Field</th>
                    <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Current value</th>
                    <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Source used</th>
                    <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Age</th>
                    <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {divergentItems.map(item => (
                    <tr key={`${item.ticker}:${item.field}`} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                      <td className="px-2.5 py-1 font-mono font-semibold text-white">{item.ticker}</td>
                      <td className="px-2.5 py-1 font-mono text-amber-200/50">{item.field}</td>
                      <td className="px-2.5 py-1 text-right font-mono tabular-nums text-amber-200/50">
                        {item.winningValue != null ? item.winningValue.toPrecision(5) : "—"}
                      </td>
                      <td className="px-2.5 py-1 text-amber-200/50">{item.winningSource ?? "—"}</td>
                      <td className="px-2.5 py-1 text-amber-200/50">{fmtDate(item.fetchedAt)}</td>
                      <td className="px-2.5 py-1 text-right">
                        <button
                          onClick={e => openCell(item.ticker, item.field, e, [])}
                          className="text-[10px] px-2 py-0.5 border border-[#d4af37]/20 rounded hover:text-white text-amber-200/50 transition-colors"
                        >
                          Review
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-1 p-0.5 bg-zinc-950 border border-[#d4af37]/20 rounded-md w-fit text-[11px] font-semibold">
          {([
            { id: "fundamentals" as const, label: "Fundamentals" },
            { id: "technicals" as const, label: "Technicals" },
            { id: "peers" as const, label: "Peers" },
          ]).map(mode => (
            <button
              key={mode.id}
              onClick={() => setViewMode(mode.id)}
              className={cn(
                "px-2.5 py-1.5 rounded transition-colors",
                viewMode === mode.id
                  ? "bg-[#d4af37] text-black"
                  : "text-amber-200/50 hover:text-[#d4af37]",
              )}
            >
              {mode.label}
            </button>
          ))}
        </div>

        {viewMode !== "peers" && (
          <div className="flex items-center gap-4">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-amber-200/30 pointer-events-none" />
              <input
                type="text"
                value={tickerFilter}
                onChange={e => setTickerFilter(e.target.value)}
                placeholder="Filter tickers…"
                className="pl-6 pr-3 py-1 text-xs bg-zinc-950 border border-[#d4af37]/20 text-white placeholder:text-amber-200/30 rounded-md focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50 w-44"
              />
              {tickerFilter && (
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-amber-200/30 tabular-nums">
                  {visibleRows}/{data.length}
                </span>
              )}
            </div>
            <div className="flex gap-3 text-xs text-amber-200/50">
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-red-500/30 border border-red-500/50" /> Null</span>
              <span className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded bg-amber-500/30 border border-amber-500/50" /> Suspect</span>
              <span className="flex items-center gap-1"><span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/25 text-amber-400 border border-amber-500/40 font-medium">rep</span> Representative (watchlist)</span>
            </div>
          </div>
        )}
      </div>

      {viewMode === "peers" ? (
        <PeerGroupsTab />
      ) : (
      /* Grid */
      <div className="rounded-md border border-[#d4af37]/25 overflow-auto max-h-[calc(100vh-300px)] bg-zinc-950 shadow-lg shadow-black/60">
        <table className="text-xs border-collapse min-w-max">
          <thead className="sticky top-0 z-20 bg-black text-[#d4af37]">
            {viewMode === "fundamentals" ? (<>
              {/* Fundamentals — family header row */}
              <tr>
                <th
                  className="sticky left-0 z-30 bg-black border-b border-r border-[#d4af37]/25 px-2.5 py-1 text-left font-semibold text-[11px] uppercase tracking-wider cursor-pointer hover:bg-amber-500/10 select-none"
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
                      className={cn("border-b border-r border-[#d4af37]/25 px-2 py-1 text-center font-semibold uppercase tracking-wider text-[10px]", FAMILY_COLORS[fam])}
                    >
                      <div>{fam}</div>
                      <div className={cn("text-[9px] font-normal tracking-normal normal-case mt-0.5 opacity-80 tabular-nums", coverageColor(pct))}>
                        {cov ? `${cov.filled}/${cov.total * cols.length} filled · ${pct}%` : "—"}
                      </div>
                    </th>
                  );
                })}
              </tr>
              {/* Fundamentals — column labels row */}
              <tr>
                {COLS.map((col, i) => {
                  const cov = colCoverage[col.key as string];
                  const pct = cov && cov.total > 0 ? Math.round((cov.filled / cov.total) * 100) : 0;
                  return (
                    <th
                      key={col.key as string}
                      onClick={() => handleSort(col.key as string)}
                      className={cn(
                        "border-b border-[#d4af37]/25 px-2 py-1 font-medium whitespace-nowrap cursor-pointer hover:bg-amber-500/10 select-none",
                        i === COLS.length - 1 ? "" : "border-r border-[#d4af37]/10",
                        FAMILY_COLORS[col.family],
                      )}
                    >
                      <div className="flex items-center justify-end gap-0.5">
                        <span>{col.label}</span>
                        <SortIcon colKey={col.key as string} sortCol={sortCol} sortDir={sortDir} />
                      </div>
                      {cov && (
                        <div className={cn(
                          "text-[9px] font-normal text-right mt-0.5 tabular-nums",
                          pct === 0 ? "text-red-400/70" : pct < 50 ? "text-red-400" : pct < 80 ? "text-amber-400" : "text-green-500/70"
                        )}>
                          {cov.filled}/{cov.total}
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </>) : (<>
              {/* Technicals — family header row */}
              <tr>
                <th
                  className="sticky left-0 z-30 bg-black border-b border-r border-[#d4af37]/25 px-2.5 py-1 text-left font-semibold text-[11px] uppercase tracking-wider"
                  rowSpan={2}
                >
                  Ticker
                </th>
                {techFamilies.map(fam => {
                  const cols = TECH_COLS.filter(c => c.family === fam);
                  return (
                    <th
                      key={fam}
                      colSpan={cols.length}
                      className={cn("border-b border-r border-[#d4af37]/25 px-2 py-1 text-center font-semibold uppercase tracking-wider text-[10px]", TECH_FAMILY_COLORS[fam])}
                    >
                      {fam}
                    </th>
                  );
                })}
              </tr>
              {/* Technicals — column labels row */}
              <tr>
                {TECH_COLS.map((col, i) => (
                  <th
                    key={col.key as string}
                    className={cn(
                      "border-b border-[#d4af37]/25 px-2 py-1 font-medium whitespace-nowrap",
                      i < TECH_COLS.length - 1 && "border-r border-[#d4af37]/10",
                      TECH_FAMILY_COLORS[col.family],
                    )}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </>)}
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
                    <td colSpan={(viewMode === "fundamentals" ? COLS.length : TECH_COLS.length) + 1} className={cn("p-0 border-l-4", pal.border)}>
                      <div className={cn("flex items-center gap-2.5 px-3 py-2.5", pal.bg)}>
                        {isCollapsed
                          ? <ChevronRight className={cn("h-3.5 w-3.5 flex-shrink-0", pal.chevron)} />
                          : <ChevronDown  className={cn("h-3.5 w-3.5 flex-shrink-0", pal.chevron)} />
                        }
                        <span className={cn("font-bold text-[11px] uppercase tracking-widest", pal.text)}>{item.label}</span>
                        <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium tabular-nums", pal.badge)}>{item.count} tickers</span>
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
                  <>
                  <tr
                    key={`group-${item.groupId}-${idx}`}
                    className="cursor-pointer select-none hover:bg-amber-500/5 transition-colors border-b border-[#d4af37]/10"
                    onClick={() => toggleGroup(item.groupId)}
                  >
                    <td colSpan={(viewMode === "fundamentals" ? COLS.length : TECH_COLS.length) + 1} className={cn("p-0 border-l-4", pal.border)}>
                      <div className="flex items-center gap-2.5 pl-7 pr-3 py-1.5 bg-white/[0.04]">
                        {isCollapsed
                          ? <ChevronRight className="h-3 w-3 text-amber-200/40 flex-shrink-0" />
                          : <ChevronDown  className="h-3 w-3 text-amber-200/40 flex-shrink-0" />
                        }
                        <span className="text-xs font-semibold text-white/90 tracking-wide">{item.groupName}</span>
                        <span className="text-[10px] text-amber-200/40 font-mono tabular-nums">{item.count}</span>
                        {/* Per-family coverage pills */}
                        <div className="flex items-center gap-1 ml-2">
                          {families.map(fam => {
                            const fc = item.famCov[fam];
                            if (!fc || fc.total === 0) return null;
                            const pct = Math.round((fc.filled / fc.total) * 100);
                            return (
                              <span
                                key={fam}
                                className={cn(
                                  "text-[9px] px-1 py-px rounded font-medium tabular-nums",
                                  pct < 50 ? "bg-red-500/15 text-red-400/80"
                                  : pct < 80 ? "bg-amber-500/15 text-amber-400/80"
                                  : "bg-green-500/10 text-green-500/70",
                                )}
                              >
                                {fam[0].toUpperCase()} {pct}%
                              </span>
                            );
                          })}
                        </div>
                        <div className="ml-auto flex items-center gap-2">
                          <div className="w-16 h-1 rounded-full bg-black/40 overflow-hidden">
                            <div className={cn("h-full rounded-full", coverageBarColor(item.coverage))} style={{ width: `${item.coverage}%` }} />
                          </div>
                          <span className={cn("text-[10px] tabular-nums w-8 text-right font-medium", coverageColor(item.coverage))}>
                            {item.coverage}%
                          </span>
                        </div>
                      </div>
                    </td>
                  </tr>
                  {/* Per-group column sub-header when expanded */}
                  {!isCollapsed && (
                    <tr key={`group-cols-${item.groupId}`} className="border-b border-[#d4af37]/10">
                      <td className={cn(
                        "sticky left-0 z-10 bg-black border-r border-[#d4af37]/10 px-2.5 py-0.5",
                        "text-[9px] font-semibold text-amber-200/40 tracking-wide",
                        pal.border, "border-l-4",
                      )}>
                        TICKER
                      </td>
                      {viewMode === "fundamentals"
                        ? COLS.map((col, i) => (
                          <td key={col.key as string} className={cn("text-right px-2 py-0.5 text-[9px] font-semibold whitespace-nowrap", i < COLS.length - 1 && "border-r border-[#d4af37]/10", FAMILY_COLORS[col.family])}>
                            {col.label}
                          </td>
                        ))
                        : TECH_COLS.map((col, i) => (
                          <td key={col.key as string} className={cn("text-right px-2 py-0.5 text-[9px] font-semibold whitespace-nowrap", i < TECH_COLS.length - 1 && "border-r border-[#d4af37]/10", TECH_FAMILY_COLORS[col.family])}>
                            {col.label}
                          </td>
                        ))
                      }
                    </tr>
                  )}
                </>
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
                    "border-b border-[#d4af37]/10 hover:bg-amber-500/10 transition-colors",
                    row.isWatchlist
                      ? "bg-amber-500/8 border-l-2 border-l-amber-500/50"
                      : ri % 2 === 0 ? "bg-zinc-900/70" : "bg-zinc-800/60",
                  )}
                >
                  {/* Ticker cell — sticky */}
                  <td className={cn(
                    "sticky left-0 z-10 border-r border-[#d4af37]/20 px-2.5 py-0.5 font-mono font-semibold whitespace-nowrap",
                    row.isWatchlist ? "bg-amber-950/30" : "bg-zinc-950",
                  )}>
                    <div className="flex items-center gap-1.5">
                      <span className={row.isWatchlist ? "text-amber-300" : "text-white"}>{row.ticker}</span>
                      {row.isWatchlist && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-amber-500/25 text-amber-400 border border-amber-500/40 font-sans font-medium">rep</span>
                      )}
                      {!f && (
                        <span className="text-[9px] px-1 py-0.5 rounded bg-red-500/20 text-red-400 border border-red-500/30">NO DATA</span>
                      )}
                    </div>
                    {row.companyName && (
                      <div className="text-[9px] text-amber-200/40 truncate max-w-[120px]">{row.companyName}</div>
                    )}
                  </td>

                  {/* Metric cells */}
                  {viewMode === "fundamentals" ? COLS.map((col, ci) => {
                    const raw = f ? (f[col.key] as string | null) : null;
                    const isNull = raw == null;
                    const isOptionalNull = isNull && !!col.optional;
                    const hardInvalid = isSuspect(col, raw);
                    const z = zScoreMap.get(row.peerGroupId ?? "__unclassified")?.get(col.key as string)?.get(row.ticker);
                    const isStatOutlier = z != null && Math.abs(z) > 3.0;
                    const suspect = hardInvalid || isStatOutlier;
                    const flags = f?.discrepancyFlags?.split(",") ?? [];
                    const hasFlag = flags.includes(col.key as string);
                    const overrideFlags = f?.overrideFlags?.split(",") ?? [];
                    const hasOverride = overrideFlags.includes(col.key as string);
                    const isActive = activeCell?.ticker === row.ticker && activeCell?.field === (col.key as string);
                    const justRefetched = justSucceeded.has(`${row.ticker}:${col.key as string}`);
                    const tooltipParts: string[] = [];
                    if (suspect) {
                      if (hardInvalid) tooltipParts.push(`Suspect: ${col.label} value is structurally invalid (e.g. negative when it shouldn't be)`);
                      else if (isStatOutlier) tooltipParts.push(`Outlier: z = ${z!.toFixed(1)} — unusually ${z! > 0 ? "high" : "low"} vs peer group median`);
                    }
                    if (hasFlag) tooltipParts.push(`Discrepancy: multiple data sources report different values for ${col.label}`);
                    if (hasOverride) tooltipParts.push(`Manual override active for ${col.label} — a source other than default priority was picked after review`);
                    return (
                      <td
                        key={col.key as string}
                        onClick={(e) => openCell(row.ticker, col.key as string, e, tooltipParts)}
                        className={cn(
                          "px-2 py-0.5 text-right font-mono whitespace-nowrap tabular-nums border-[#d4af37]/10 transition-colors text-amber-200/70",
                          (isAdmin || tooltipParts.length > 0) && "cursor-pointer",
                          ci < COLS.length - 1 && "border-r",
                          isActive && "ring-1 ring-inset ring-[#d4af37]/60",
                          isOptionalNull && "text-amber-200/25",
                          !isOptionalNull && isNull && "bg-red-500/15 text-red-400/70",
                          !isNull && hasFlag && "bg-sky-500/15",
                          !isNull && suspect && "ring-1 ring-inset ring-amber-500/80",
                          !isNull && hasOverride && "ring-1 ring-inset ring-blue-500/80",
                          // Transient re-fetch success flash — !important so it visibly
                          // wins over the other conditional backgrounds above while active.
                          justRefetched && "!bg-green-500/25 !ring-1 !ring-inset !ring-green-500/70",
                        )}
                        title={justRefetched ? "Re-fetched successfully" : undefined}
                      >
                        {isOptionalNull ? "—" : isNull ? <span className="text-red-500/50">null</span> : isNearZeroBase(col, raw) ? <span className="text-amber-200/30" title="Not meaningful — prior period near zero">N/M</span> : fmt(raw, col.fmt)}
                      </td>
                    );
                  }) : TECH_COLS.map((col, ci) => {
                    const t = row.technicals;
                    const raw = t ? t[col.key] : null;
                    const isNull = raw == null;
                    const isText = col.fmt === txt || col.fmt === flag;
                    const regimeColor = col.key === "regime" && !isNull
                      ? raw === "BULLISH" ? "text-green-400" : raw === "BEARISH" ? "text-red-400" : "text-amber-400"
                      : null;
                    const signalColor = col.key === "fallingKnife" && Number(raw) === 1 ? "text-red-400 font-bold" : null;
                    return (
                      <td
                        key={col.key as string}
                        className={cn(
                          "px-2 py-0.5 font-mono whitespace-nowrap tabular-nums border-[#d4af37]/10",
                          isText ? "text-center" : "text-right",
                          ci < TECH_COLS.length - 1 && "border-r",
                          isNull ? "text-amber-200/20" : regimeColor ?? signalColor ?? "text-amber-200/70",
                        )}
                      >
                        {col.fmt(raw)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {visibleRows === 0 && tickerFilter && (
              <tr>
                <td colSpan={(viewMode === "fundamentals" ? COLS.length : TECH_COLS.length) + 1} className="py-8 text-center text-amber-200/40 text-xs">
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
        className="w-80 p-0 text-xs overflow-hidden bg-zinc-950 border border-[#d4af37]/25 shadow-lg shadow-black/60"
        align="start"
        sideOffset={4}
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
            <div className="px-3 py-2 border-b border-[#d4af37]/20 bg-black/40 flex items-center justify-between gap-2">
              <span className="font-semibold text-white">{activeCell?.ticker} · {activeCell?.field}</span>
              <div className="flex items-center gap-1">
                {activeProv.isOverride && <span title="Manual override active"><Pin className="h-3 w-3 text-amber-400" /></span>}
                {activeProv.divergent  && <span title="Sources disagree"><TriangleAlert className="h-3 w-3 text-orange-400" /></span>}
              </div>
            </div>

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

            <div className="px-3 py-2 border-b border-[#d4af37]/20">
              <div className="flex items-center justify-between">
                <span className="text-amber-200/40">Winner</span>
                <span className="font-mono font-medium tabular-nums text-white">
                  {activeProv.winningValue != null
                    ? activeProv.winningValue.toPrecision(5)
                    : <span className="text-red-400/70">null</span>}
                </span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-amber-200/40">Source</span>
                <span className="font-mono text-amber-200/70">{activeProv.winningSource ?? "—"}</span>
              </div>
              <div className="flex items-center justify-between mt-0.5">
                <span className="text-amber-200/40">Age</span>
                <span className="font-mono text-amber-200/70">{fmtDate(activeProv.fetchedAt)}</span>
              </div>
              {activeProv.divergent && (
                <div className="mt-1.5 text-[10px] text-orange-400 flex items-center gap-1">
                  <TriangleAlert className="h-2.5 w-2.5" /> Sources disagree on this value
                </div>
              )}
            </div>

            <div className="px-3 py-2 border-b border-[#d4af37]/20">
              <div className="text-[10px] font-semibold text-[#d4af37]/80 uppercase tracking-wide mb-1">All sources</div>
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
