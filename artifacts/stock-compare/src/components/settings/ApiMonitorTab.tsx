import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ── Data Health types ─────────────────────────────────────────────────────────

interface DataHealthResponse {
  totalActive: number;
  fresh: number;
  stale: number;
  neverFetched: number;
  staleDaysThreshold: number;
  divergentCount: number;
  topNullFields: { field: string; nullCount: number }[];
  lastEnrichmentRun: string | null;
  lastEnrichmentTrigger?: string | null;
  lastEnrichmentStatus?: string | null;
  enrichmentRunning: boolean;
  bronze: { polygonRows: number; avRows: number };
}

// ── Rate limit metadata (hardcoded — doesn't change) ──────────────────────────

type LimitKind = "daily" | "per-min" | "per-sec" | "none";

interface SourceMeta {
  label: string;
  limitKind: LimitKind;
  dailyLimit?: number;     // only for "daily"
  rateNote?: string;       // displayed for non-daily sources
}

const SOURCE_META: Record<string, SourceMeta> = {
  factset:{ label: "FactSet",      limitKind: "daily",   dailyLimit: 500, rateNote: "500/day (referee)" },
  fmp:    { label: "FMP",          limitKind: "daily",   dailyLimit: 220, rateNote: "220/day (headroom under ~250)" },
  av:     { label: "Alpha Vantage",limitKind: "daily",   dailyLimit: 25,  rateNote: "25/day"  },
  polygon:{ label: "Polygon",      limitKind: "per-min", rateNote: "5 req/min · shared gate" },
  schwab: { label: "Schwab",       limitKind: "per-min", rateNote: "120 req/min · market data" },
  polygon_429:{ label: "Polygon 429s", limitKind: "per-min", rateNote: "should stay 0" },
  finnhub:{ label: "Finnhub",      limitKind: "per-min", rateNote: "60 req/min" },
  yahoo:  { label: "Yahoo",        limitKind: "none",    rateNote: "fundamentals counted · quotes/chains not" },
  edgar:  { label: "SEC EDGAR",    limitKind: "per-sec", rateNote: "10 req/sec" },
  fred:   { label: "FRED",         limitKind: "none",    rateNote: "no hard limit" },
  cnn:    { label: "CNN",          limitKind: "none",    rateNote: "no hard limit" },
  nyfed:  { label: "NY Fed",       limitKind: "none",    rateNote: "no hard limit" },
  anthropic: { label: "Anthropic (Haiku)", limitKind: "none", rateNote: "30 req/15min per user" },
  lseg:   { label: "LSEG Workspace", limitKind: "daily", dailyLimit: 10000, rateNote: "10k req/day · CLI sync only" },
  wrds:   { label: "WRDS",         limitKind: "none",    rateNote: "CLI sync only · counts when you pull" },
  tastytrade: { label: "tastytrade", limitKind: "none",  rateNote: "no published cap · ~3 calls/day (daily.py) + backtests" },
};

// Show these sources always (even with 0 calls); others shown only if they have data.
const PRIMARY_SOURCES = ["factset", "fmp", "av", "polygon", "polygon_429", "schwab", "finnhub", "yahoo", "edgar", "anthropic", "lseg", "wrds", "tastytrade"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function localIsoDate(d: Date): string {
  // Local calendar day — NOT toISOString() (UTC), which flips "Today" after 5pm PT.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function buildDateLabels(days: number): { iso: string; label: string }[] {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setHours(12, 0, 0, 0); // noon avoids DST edge weirdness
    d.setDate(d.getDate() - i);
    const iso = localIsoDate(d);
    const label = i === 0 ? "Today" : i === 1 ? "Yesterday" : iso.slice(5); // MM-DD
    return { iso, label };
  });
}

function usageColor(pct: number): string {
  if (pct >= 90) return "bg-red-500";
  if (pct >= 60) return "bg-yellow-500";
  return "bg-green-500";
}

function usageTextColor(pct: number): string {
  if (pct >= 90) return "text-red-400";
  if (pct >= 60) return "text-yellow-400";
  return "text-green-400";
}

// ── Component ─────────────────────────────────────────────────────────────────

interface UsageRow { source: string; date: string; callsMade: number; }

interface LocalStackService {
  up: boolean;
  pid: number | null;
  ageSec: number | null;
  orphan: boolean;
  port: number;
}

interface LocalStackResponse {
  enabled: boolean;
  api: LocalStackService;
  vite: LocalStackService;
  orphans: { pid: number; port: number; cmd: string }[];
  hint: string;
  clean: boolean;
}

function formatAge(sec: number | null): string {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h`;
}

/** Compact M/D or M/D Ha (local). */
function shortWhen(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const h = d.getHours();
  const m = d.getMinutes();
  if (h === 0 && m === 0) return md;
  const h12 = ((h + 11) % 12) + 1;
  const ap = h < 12 ? "a" : "p";
  return m === 0 ? `${md} ${h12}${ap}` : `${md} ${h12}:${String(m).padStart(2, "0")}${ap}`;
}

function ageLabel(ageMs: number | null | undefined): string {
  if (ageMs == null) return "—";
  const h = ageMs / 3_600_000;
  if (h < 48) return `${Math.max(1, Math.round(h))}h`;
  return `${Math.round(h / 24)}d`;
}

type Tone = "ok" | "warn" | "down" | "idle";

function Dot({ tone }: { tone: Tone }) {
  const color =
    tone === "ok" ? "bg-green-500"
    : tone === "warn" ? "bg-amber-400"
    : tone === "idle" ? "bg-zinc-500"
    : "bg-red-500";
  return <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", color)} />;
}

/** Dot + name under; metrics only in Radix tooltip (native title often fails under overflow). */
function Chip({
  label, tone, tip,
}: { label: string; tone: Tone; tip: string }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex flex-1 min-w-0 flex-col items-center justify-end gap-px px-0.5 rounded-sm hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d4af37]/40"
        >
          <Dot tone={tone} />
          <span className="text-[8px] leading-none text-white/65 whitespace-nowrap">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="max-w-[280px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug font-normal normal-case tracking-normal"
      >
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

function tipJoin(...parts: (string | null | undefined | false)[]): string {
  return parts.filter(Boolean).join(" · ");
}

export function ApiMonitorTab() {
  const DAYS = 5;
  const dates = buildDateLabels(DAYS);

  const { data, isFetching, refetch, dataUpdatedAt } = useQuery<UsageRow[]>({
    queryKey: ["api-usage", "history", DAYS],
    queryFn: async () => {
      const res = await fetch(`/api/api-usage/history?days=${DAYS}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load API usage");
      return res.json();
    },
    staleTime: 0,
    gcTime: 60 * 60_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;

  const { data: health } = useQuery<DataHealthResponse>({
    queryKey: ["data-health"],
    queryFn: async () => {
      const res = await fetch("/api/admin/data-health", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load data health");
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  // A130: month-to-date metered LLM calls (every Haiku call, user or system job) → est $.
  const { data: aiSpend } = useQuery<{
    since: string; calls: number; inputTokens: number; outputTokens: number; estUsd: number;
    bySurface: { surfaceType: string; calls: number; estUsd: number }[];
  }>({
    queryKey: ["ai-spend"],
    queryFn: async () => {
      const res = await fetch("/api/api-usage/ai-spend", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load AI spend");
      return res.json();
    },
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  const { data: localStack } = useQuery<LocalStackResponse>({
    queryKey: ["local-stack"],
    queryFn: async () => {
      const res = await fetch("/api/admin/local-stack", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load local stack");
      return res.json();
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
  });

  const { data: schwab } = useQuery<{
    configured: boolean;
    clientReady: boolean;
    hasTokens: boolean;
    accessValid: boolean;
    refreshDaysLeft: number | null;
    refreshExpiresAt: string | null;
    warningLevel: "ok" | "warn" | "urgent" | "down";
    reauthHint: string | null;
    lastError: string | null;
    usage?: {
      rpmBudget: number;
      requestsLast60s: number;
      totalRequests: number;
      last429At: string | null;
      chainCache: { entryCount: number; hitRate: string };
    };
    optionsChainSource?: {
      schwab: number;
      yahoo: number;
      total: number;
      schwabSharePct: number | null;
      schwabZeroBid?: number;
      yahooZeroBid?: number;
    };
  }>({
    queryKey: ["schwab-status"],
    queryFn: async () => {
      const res = await fetch("/api/schwab/status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load Schwab status");
      return res.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const startSchwabOAuth = async () => {
    const res = await fetch("/api/schwab/oauth/start", { method: "POST", credentials: "include" });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "oauth start failed");
    window.open(body.authorizeUrl as string, "schwab-oauth", "noopener,noreferrer");
  };

  type ResearchOps = {
    checkedAt: string;
    localDb?: { ok: boolean; error: string | null };
    wrds: {
      overall: string;
      schema: boolean;
      envHint?: string | null;
      datasets: { dataset: string; lastOkAt: string | null; status: string; lastRows: number | null; ageMs?: number | null }[];
      lastError: { dataset: string; error: string; finishedAt: string | null } | null;
    };
    lseg: {
      overall: string;
      schema: boolean;
      desktopProxy: { reachable: boolean };
      datasets: { dataset: string; lastOkAt: string | null; status: string; lastRows: number | null; ageMs?: number | null }[];
      lastError: { dataset: string; error: string; finishedAt: string | null } | null;
    };
    fixHints: string[];
  };

  const { data: researchOps } = useQuery<ResearchOps>({
    queryKey: ["research-ops"],
    queryFn: async () => {
      const res = await fetch("/api/research/ops", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load research ops");
      return res.json();
    },
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Pivot: source → date → callsMade
  const pivot = new Map<string, Map<string, number>>();
  for (const row of data ?? []) {
    if (!pivot.has(row.source)) pivot.set(row.source, new Map());
    pivot.get(row.source)!.set(row.date, row.callsMade);
  }

  // Determine which sources to show
  const allSources = new Set([...PRIMARY_SOURCES, ...pivot.keys()]);
  const sources = [...allSources].sort((a, b) => {
    const ai = PRIMARY_SOURCES.indexOf(a), bi = PRIMARY_SOURCES.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  const todayIso = dates[0]?.iso;
  const todayCalls = (src: string) => (todayIso ? (pivot.get(src)?.get(todayIso) ?? 0) : 0);
  const vendorTone = (src: string): Tone => {
    const n = todayCalls(src);
    if (n > 0) return "ok";
    return "idle"; // configured in grid; no live probe — idle ≠ down
  };
  const wrdsTone: Tone =
    !researchOps ? "idle"
    : researchOps.wrds.overall === "ok" ? "ok"
    : researchOps.wrds.overall === "warn" ? "warn"
    : "down";
  const lsegTone: Tone =
    !researchOps ? "idle"
    : researchOps.lseg.overall === "ok" && researchOps.lseg.desktopProxy.reachable ? "ok"
    : researchOps.lseg.overall === "down" ? "down"
    : "warn";
  const schwabTone: Tone =
    !schwab ? "idle"
    : schwab.clientReady ? "ok"
    : schwab.warningLevel === "warn" || schwab.warningLevel === "urgent" ? "warn"
    : "down";
  const ageFromLastOk = (datasets: { lastOkAt: string | null; ageMs?: number | null }[] | undefined) => {
    if (!datasets?.length) return null;
    const fromMs = datasets.map((d) => d.ageMs).filter((a): a is number => a != null);
    if (fromMs.length) return Math.min(...fromMs);
    const ages = datasets
      .map((d) => (d.lastOkAt ? Date.now() - new Date(d.lastOkAt).getTime() : null))
      .filter((a): a is number => a != null);
    return ages.length ? Math.min(...ages) : null;
  };

  const vendorTip = (src: string, label: string) => {
    const n = todayCalls(src);
    return tipJoin(
      n > 0 ? "ok" : "idle",
      n > 0 ? `${n} today` : "0 today",
      SOURCE_META[src]?.rateNote ?? label,
    );
  };

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 max-w-4xl space-y-3">
      {/* One strip: local stack + vendors + research caches. Hover chip for metrics. */}
      <div className="rounded-md border border-[#d4af37]/20 bg-black/40 px-2 py-1.5 flex flex-nowrap items-end w-full gap-0">
        <span className="self-center font-semibold text-[#d4af37]/80 uppercase tracking-wide text-[9px] shrink-0 pr-1">
          Conn
        </span>
        {localStack?.enabled && (
          <>
            <Chip
              label="API"
              tone={localStack.api.up ? (localStack.api.orphan ? "warn" : "ok") : "down"}
              tip={tipJoin(
                localStack.api.up ? "up" : "down",
                localStack.api.up ? `up ${formatAge(localStack.api.ageSec)}` : null,
                localStack.api.pid != null ? `pid ${localStack.api.pid}` : null,
                localStack.api.orphan ? "orphan" : null,
                `:${localStack.api.port}`,
              )}
            />
            <Chip
              label="Vite"
              tone={localStack.vite.up ? (localStack.vite.orphan ? "warn" : "ok") : "down"}
              tip={tipJoin(
                localStack.vite.up ? "up" : "down",
                localStack.vite.up ? `up ${formatAge(localStack.vite.ageSec)}` : null,
                localStack.vite.pid != null ? `pid ${localStack.vite.pid}` : null,
                localStack.vite.orphan ? "orphan" : null,
                `:${localStack.vite.port}`,
                "long-lived OK — restart only if HMR/memory bad",
              )}
            />
          </>
        )}
        {researchOps?.localDb && (
          <Chip
            label="DB"
            tone={researchOps.localDb.ok ? "ok" : "down"}
            tip={tipJoin(
              researchOps.localDb.ok ? "ok" : "down",
              researchOps.localDb.error ?? "Postgres",
            )}
          />
        )}
        {schwab && (
          <Chip
            label="Schwab"
            tone={schwabTone}
            tip={tipJoin(
              schwab.clientReady ? "ready" : (schwab.hasTokens ? "auth needed" : "not linked"),
              schwab.refreshDaysLeft != null ? `refresh ${schwab.refreshDaysLeft.toFixed(0)}d` : null,
              schwab.refreshExpiresAt ? `exp ${shortWhen(schwab.refreshExpiresAt)}` : null,
              schwab.usage ? `${schwab.usage.requestsLast60s}/${schwab.usage.rpmBudget} rpm` : null,
              schwab.optionsChainSource?.total
                ? `chains ${schwab.optionsChainSource.schwabSharePct}% Sw / ${100 - (schwab.optionsChainSource.schwabSharePct ?? 0)}% Y`
                : null,
              (schwab.optionsChainSource?.schwabZeroBid || schwab.optionsChainSource?.yahooZeroBid)
                ? `zero-bid DQ Sw${schwab.optionsChainSource.schwabZeroBid ?? 0}/Y${schwab.optionsChainSource.yahooZeroBid ?? 0}`
                : null,
              schwab.reauthHint,
            )}
          />
        )}
        <Chip
          label="Yahoo"
          tone="ok"
          tip={tipJoin("ok", "quotes/chains fallback", `${todayCalls("yahoo")} funda today`)}
        />
        <Chip label="FS" tone={vendorTone("factset")} tip={vendorTip("factset", "FactSet")} />
        <Chip label="FH" tone={vendorTone("finnhub")} tip={vendorTip("finnhub", "Finnhub")} />
        <Chip label="FMP" tone={vendorTone("fmp")} tip={vendorTip("fmp", "FMP")} />
        <Chip label="Poly" tone={vendorTone("polygon")} tip={vendorTip("polygon", "Polygon")} />
        <Chip label="AV" tone={vendorTone("av")} tip={vendorTip("av", "Alpha Vantage")} />
        <Chip label="EDG" tone={vendorTone("edgar")} tip={vendorTip("edgar", "EDGAR")} />
        {researchOps && (
          <>
            <Chip
              label="WRDS"
              tone={wrdsTone}
              tip={tipJoin(
                `cache ${researchOps.wrds.overall}`,
                `freshest ${ageLabel(ageFromLastOk(researchOps.wrds.datasets))}`,
                !researchOps.wrds.schema ? "schema missing" : null,
                "monthly supervised sync (Duo) — not LaunchAgent",
              )}
            />
            <Chip
              label="LSEG"
              tone={lsegTone}
              tip={tipJoin(
                `cache ${researchOps.lseg.overall}`,
                researchOps.lseg.desktopProxy.reachable ? "desk on :9000" : "desk off",
                `freshest ${ageLabel(ageFromLastOk(researchOps.lseg.datasets))}`,
                "weekday supervised sync — not LaunchAgent",
              )}
            />
          </>
        )}
        {localStack?.orphans && localStack.orphans.length > 0 && (
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild>
              <span className="self-center text-[9px] text-amber-400 shrink-0 cursor-help">
                {localStack.orphans.length}!
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px]"
            >
              orphan listener — node scripts/local-stack.mjs heal
            </TooltipContent>
          </Tooltip>
        )}
        {schwab && (
          <button
            type="button"
            onClick={() => { void startSchwabOAuth().catch((e) => alert(String(e?.message ?? e))); }}
            className="self-center ml-1 shrink-0 text-[9px] font-semibold uppercase tracking-wide text-[#d4af37] border border-[#d4af37]/30 rounded px-1.5 py-0.5 hover:bg-[#d4af37]/10"
          >
            Re-auth
          </button>
        )}
      </div>

      <div className="flex items-center justify-between mb-0">
        <div>
          <h2 className="text-xs font-semibold text-white uppercase tracking-wide">API Monitor</h2>
          <p className="text-[10px] text-white mt-0.5">
            PT day counts · api_usage
          </p>
          {aiSpend && (
            <Tooltip delayDuration={150}>
              <TooltipTrigger asChild>
                <p className="text-[10px] text-white/80 mt-0.5 tabular-nums cursor-help">
                  AI spend this month: ~${aiSpend.estUsd.toFixed(2)} · {aiSpend.calls} calls ·{" "}
                  {Math.round((aiSpend.inputTokens + aiSpend.outputTokens) / 1000)}k tokens ⓘ
                </p>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs text-[11px] space-y-1">
                <p>Every metered Anthropic call since {aiSpend.since} (ai_usage_log; cache hits excluded). Est = tokens × list price per model (lib/ai-pricing.ts); the Anthropic console bill is exact.</p>
                {aiSpend.bySurface.slice(0, 6).map(r => (
                  <p key={r.surfaceType} className="tabular-nums">{r.surfaceType}: {r.calls} · ${r.estUsd.toFixed(3)}</p>
                ))}
                <p className="text-white/60">Claude Code / Cursor / Muse are flat subscriptions — not counted.</p>
              </TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && <span className="text-[10px] text-white">as of {lastUpdated}</span>}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs text-white hover:text-white border border-[#d4af37]/20 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-md border border-[#d4af37]/25">
        <table className="w-full text-xs">
          <thead className="bg-black text-[#d4af37]">
            <tr className="border-b border-[#d4af37]/25">
              <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1 w-32">Source</th>
              <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Limit</th>
              {dates.map(d => (
                <th key={d.iso} className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1 whitespace-nowrap">
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {sources.map(source => {
              const meta = SOURCE_META[source] ?? { label: source, limitKind: "none" as LimitKind };
              const byDate = pivot.get(source) ?? new Map<string, number>();

              return (
                <tr key={source} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-medium text-white">{meta.label}</td>
                  <td className="px-2.5 py-1 text-white">
                    {meta.limitKind === "daily" ? (
                      <span>{meta.dailyLimit}/day</span>
                    ) : (
                      <span className="italic">{meta.rateNote}</span>
                    )}
                  </td>
                  {dates.map(d => {
                    const calls = byDate.get(d.iso) ?? 0;
                    const isDaily = meta.limitKind === "daily" && meta.dailyLimit;

                    if (isDaily) {
                      const limit = meta.dailyLimit!;
                      const pct = Math.min((calls / limit) * 100, 100);
                      return (
                        <td key={d.iso} className="px-2.5 py-1 text-right">
                          <div className="flex flex-col items-end gap-1">
                            <span className={cn("tabular-nums font-semibold", calls > 0 ? usageTextColor(pct) : "text-white")}>
                              {calls}/{limit}
                            </span>
                            <div className="w-16 h-1 rounded-full bg-zinc-800 overflow-hidden">
                              <div
                                className={cn("h-full rounded-full transition-all", calls > 0 ? usageColor(pct) : "bg-zinc-800")}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                          </div>
                        </td>
                      );
                    }

                    return (
                      <td key={d.iso} className="px-2.5 py-1 text-right tabular-nums text-white">
                        {calls === 0 ? "—" : calls}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="text-[10px] text-white mt-2">
        Grid = api_usage (funda). LSEG/WRDS increment only on CLI sync. Yahoo quotes/chains not counted.
      </p>

      {/* ── Research caches (WRDS / LSEG local) ─────────────── */}
      {researchOps && (
        <div className="mt-4 pt-3 border-t border-[#d4af37]/25 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Research caches</h2>
            <span className="text-[10px] text-white/70 tabular-nums">{shortWhen(researchOps.checkedAt)}</span>
          </div>
          <div className="flex flex-wrap items-end gap-x-3 gap-y-1">
            <Chip
              label="WRDS"
              tone={wrdsTone}
              tip={tipJoin(
                `cache ${researchOps.wrds.overall}`,
                !researchOps.wrds.schema ? "schema missing" : null,
                `freshest ${ageLabel(ageFromLastOk(researchOps.wrds.datasets))}`,
              )}
            />
            <Chip
              label="LSEG"
              tone={lsegTone}
              tip={tipJoin(
                `cache ${researchOps.lseg.overall}`,
                researchOps.lseg.desktopProxy.reachable ? "desk on" : "desk off",
                `freshest ${ageLabel(ageFromLastOk(researchOps.lseg.datasets))}`,
              )}
            />
          </div>
          <div className="overflow-x-auto rounded-md border border-[#d4af37]/25">
            <table className="w-full text-xs">
              <thead className="bg-black text-[#d4af37]">
                <tr className="border-b border-[#d4af37]/25">
                  <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Lane</th>
                  <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Dataset</th>
                  <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Status</th>
                  <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Last ok</th>
                  <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Rows</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {[
                  ...researchOps.wrds.datasets.map((d) => ({ lane: "WRDS", ...d })),
                  ...researchOps.lseg.datasets.map((d) => ({ lane: "LSEG", ...d })),
                ].map((d) => (
                  <tr key={`${d.lane}-${d.dataset}`} className="bg-zinc-900/70 even:bg-zinc-800/60">
                    <td className="px-2.5 py-1 text-white/70">{d.lane}</td>
                    <td className="px-2.5 py-1 font-mono text-white">{d.dataset}</td>
                    <td className={cn(
                      "px-2.5 py-1",
                      d.status === "ok" ? "text-green-400" : d.status === "warn" ? "text-amber-300" : "text-red-400",
                    )}>
                      {d.status}
                    </td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-white/70">
                      {shortWhen(d.lastOkAt)}
                    </td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-white/70">{d.lastRows ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {(researchOps.wrds.lastError || researchOps.lseg.lastError) && (
            <div className="text-[10px] text-red-300/80 space-y-0.5 font-mono">
              {researchOps.wrds.lastError && (
                <p>WRDS {researchOps.wrds.lastError.dataset}: {researchOps.wrds.lastError.error}</p>
              )}
              {researchOps.lseg.lastError && (
                <p>LSEG {researchOps.lseg.lastError.dataset}: {researchOps.lseg.lastError.error}</p>
              )}
            </div>
          )}
          {researchOps.fixHints.length > 0 && (
            <p className="text-[10px] text-amber-200/45">{researchOps.fixHints[0]}</p>
          )}
        </div>
      )}

      {/* ── Data Health ─────────────────────────────────────── */}
      {health && (
        <div className="mt-4 pt-3 border-t border-[#d4af37]/25">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Data Health</h2>
            {health.enrichmentRunning && (
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-yellow-500/15 text-yellow-400 border-yellow-500/30 animate-pulse">
                Enrichment running…
              </span>
            )}
          </div>

          <span className="block text-[11px] font-mono text-sky-300/60 mb-2">
            <span className="text-green-400">Fresh</span>{` ${health.fresh}`}
            {" · "}
            <span className="text-yellow-400">Stale</span>{` ${health.stale}`}
            {" · "}
            <span className="text-red-400">Never fetched</span>{` ${health.neverFetched}`}
            {" · "}
            <span className="text-white/80">Tracked</span>{` ${health.totalActive}`}
          </span>

          <div className="overflow-x-auto rounded-md border border-[#d4af37]/25">
            <table className="w-full text-xs">
              <thead className="bg-black text-[#d4af37]">
                <tr className="border-b border-[#d4af37]/25">
                  <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Field</th>
                  <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Null Count</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {health.topNullFields.map(({ field, nullCount }) => (
                  <tr key={field} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                    <td className="px-2.5 py-1 font-mono text-white">{field}</td>
                    <td className="px-2.5 py-1 text-right tabular-nums text-white/70">{nullCount}</td>
                  </tr>
                ))}
                <tr className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-medium text-white">Divergent fields (sources disagree &gt;20%)</td>
                  <td className="px-2.5 py-1 text-right tabular-nums">
                    <span className={cn(health.divergentCount > 50 ? "text-orange-400" : "text-white/70")}>
                      {health.divergentCount}
                    </span>
                  </td>
                </tr>
                <tr className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-medium text-white">
                    Polygon bronze rows
                    {health.bronze.polygonRows === 0 && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-red-500/15 text-red-400 border-red-500/30 ml-2">empty</span>
                    )}
                  </td>
                  <td className={cn("px-2.5 py-1 text-right tabular-nums", health.bronze.polygonRows === 0 ? "text-red-400" : "text-white/70")}>
                    {health.bronze.polygonRows}
                  </td>
                </tr>
                <tr className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-medium text-white">
                    AV bronze rows
                    {health.bronze.avRows === 0 && (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-red-500/15 text-red-400 border-red-500/30 ml-2">empty</span>
                    )}
                  </td>
                  <td className={cn("px-2.5 py-1 text-right tabular-nums", health.bronze.avRows === 0 ? "text-red-400" : "text-white/70")}>
                    {health.bronze.avRows}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-white/70 mt-2">
            Last enrichment:{" "}
            {health.lastEnrichmentRun
              ? new Date(health.lastEnrichmentRun).toLocaleString()
              : "not yet run"}
            {health.lastEnrichmentTrigger ? ` · ${health.lastEnrichmentTrigger}` : ""}
            {health.lastEnrichmentStatus ? ` · ${health.lastEnrichmentStatus}` : ""}
            {" · "}Mac Maintain ~7:00 AM PT (full catch-up when enrichment age ≥4d)
          </p>
        </div>
      )}
    </div>
  );
}
