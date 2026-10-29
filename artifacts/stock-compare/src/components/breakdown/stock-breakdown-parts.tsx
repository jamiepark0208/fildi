// Parts of StockBreakdown: score chips, response types, data hook, tag badges, panel shell.
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Recommendations, AnalystAction, AnalystPriceTarget, PriceTargetRange } from "../analyst-ratings-section";
import type { EarningsQuarter } from "../earnings-history-section";
import type { NewsItem } from "../news-card";
import type { ScoreHistoryPoint } from "../fund-score-history-chart";
import type { StreetSynthesisData } from "../street-synthesis-card";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { DataTip } from "../data-tip";
import {
  BREAKDOWN_GC_MS,
  BREAKDOWN_STALE_MS,
  breakdownQueryKey,
  fetchBreakdown,
} from "@/lib/breakdown-query";

/** Bright solid by score band (no zinc wash). */
export function scoreTone(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return "border-white bg-zinc-600 text-white";
  if (score >= 70) return "border-emerald-500 bg-emerald-500 text-black";
  if (score >= 50) return "border-amber-400 bg-amber-400 text-black";
  if (score >= 35) return "border-orange-500 bg-orange-500 text-black";
  return "border-rose-500 bg-rose-500 text-white";
}

/** Family chips — solid desk hues (match Stock DB / Live gold tabs). */
const PILLAR_SOLID: Record<string, string> = {
  Value:   "bg-sky-500 text-black border-sky-500",
  Growth:  "bg-emerald-500 text-black border-emerald-500",
  Quality: "bg-violet-500 text-white border-violet-500",
  Safety:  "bg-[#d4af37] text-black border-[#d4af37]",
  Tech:    "bg-cyan-400 text-black border-cyan-400",
};

/** Oval score pill — label over value (matches TagBadge shape; MemoHeader row). */
export function PillarChip({ label, score, title }: { label: string; score: number | null | undefined; title?: string }) {
  const solid = PILLAR_SOLID[label] ?? scoreTone(score);
  const chip = (
    <span
      className={cn(
        "inline-flex flex-col items-center justify-center px-2 py-0.5 rounded-full border shrink-0",
        "text-[8px] font-semibold uppercase tracking-wide leading-none",
        solid,
      )}
    >
      <span className="font-sans">{label}</span>
      <span className="font-mono tabular-nums text-[10px] font-bold leading-none mt-0.5 normal-case tracking-normal">
        {score != null && Number.isFinite(score) ? score.toFixed(0) : "—"}
      </span>
    </span>
  );
  return title ? <DataTip tip={title}>{chip}</DataTip> : chip;
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScoreEvidence {
  total: number | null;
  value: number | null;
  growth: number | null;
  quality: number | null;
  safety: number | null;
  style: string | null;
  confidence: string | null;
  coverage: number | null;
  scoredAt: string | null;
  /** Fundamentals merge vintage — inputs the score was built from (A99 Phase 2). */
  inputsAsOf?: string | null;
  topMetrics: Array<{ key: string; family: string; raw: number | null; peerPct: number | null; contrib: number }>;
  modelScore: number | null;
  deskScore: number | null;
  activeAdjPoints: number;
}

export interface TradeOverlay {
  techScore: number | null;
  atmPutIv: number | null;
  realizedVol20d: number | null;
  ivVsRealized: number | null;
  earningsDaysOut: number | null;
  streetEventRisk: boolean;
  regime: string | null;
  techAsOf?: string | null;
}

export type EtfProfile = {
  kind: "etf";
  category: string | null;
  family: string | null;
  totalAssets: number | null;
  yield: number | null;
  ytdReturn: number | null;
  trailingPe: number | null;
  holdings: Array<{ symbol: string; holdingPercent: number | null }>;
};

export interface BreakdownData {
  metrics: any;
  scoreEvidence?: ScoreEvidence | null;
  scoreHistory?: ScoreHistoryPoint[];
  street?: StreetSynthesisData | null;
  tradeOverlay?: TradeOverlay | null;
  recommendations: Recommendations | null;
  analystActions: AnalystAction[];
  analystPriceTargets: AnalystPriceTarget[];
  priceTargetRange: PriceTargetRange | null;
  bullBullets: string[];
  bearBullets: string[];
  /** ISO time when event-bullets last fired for this name (null = fund-metric cases only). */
  eventBulletsGeneratedAt?: string | null;
  news: NewsItem[];
  earningsDate?: string | null;
  earningsHistory?: EarningsQuarter[];
  catalysts?: string[];
  peers?: string[];
  peerIndustry?: string | null;
  peerSector?: string | null;
  /** ETF / fund strip — set when Yahoo quoteType is ETF (stock fund model N/A). */
  etfProfile?: EtfProfile | null;
}

// ── Data fetching ──────────────────────────────────────────────────────────────

export function useBreakdown(ticker: string | null) {
  const t = ticker?.trim().toUpperCase() || null;
  return useQuery<BreakdownData, Error>({
    queryKey: t ? breakdownQueryKey(t) : ["breakdown", null],
    queryFn: () => fetchBreakdown(t!) as Promise<BreakdownData>,
    enabled: !!t,
    staleTime: BREAKDOWN_STALE_MS,
    gcTime: BREAKDOWN_GC_MS,
    // Revalidate when the view mounts if cache is stale (SWR). In-flight dedupe with prefetch.
    refetchOnMount: true,
    retry: 1,
  });
}

// ── Sub-components ─────────────────────────────────────────────────────────────

export function overviewBullets(description: string, companyName: string | null | undefined): string[] {
  const sentences = description.split(/(?<=[.!?])\s+/);
  const filtered = sentences.filter((s, i) => {
    if (i !== 0) return true;
    if (!companyName?.trim()) return true;
    const trimmed = s.trim();
    const name = companyName.trim();
    if (trimmed.toLowerCase().startsWith(name.toLowerCase())) return false;
    if (trimmed.replace(/[.!?]+$/, "").toLowerCase() === name.toLowerCase()) return false;
    return true;
  });
  return filtered.slice(0, 3);
}

// ── Classification tags (exchange/sector/industry/stockType) ───────────────────
// Each tag type gets its own color so the row reads as distinct categories rather
// than a wall of grey text. Clicking a tag opens a popup listing other watchlist
// tickers sharing that same value.

export type ClassificationTagType = "exchange" | "sector" | "industry" | "stockType";
export type TagType = ClassificationTagType | "beta" | "marketCap";

export interface WatchlistTagEntry {
  companyName?: string | null;
  exchange?: string | null;
  sector?: string | null;
  industry?: string | null;
  stockType?: string | null;
}

/** Bright solid fills — no muted zinc / opacity washes. */
export const TAG_STYLES: Record<TagType, string> = {
  exchange:  "border-sky-500 bg-sky-500 text-black hover:brightness-110",
  sector:    "border-violet-500 bg-violet-500 text-white hover:brightness-110",
  industry:  "border-teal-400 bg-teal-400 text-black hover:brightness-110",
  stockType: "border-amber-400 bg-amber-400 text-black hover:brightness-110",
  beta:      "border-rose-500 bg-rose-500 text-white hover:brightness-110",
  marketCap: "border-blue-500 bg-blue-500 text-white hover:brightness-110",
};

export function TagBadge({
  type, value, matches, onSelectTicker, title,
}: {
  type: TagType; value: string;
  matches?: { ticker: string; companyName: string | null }[];
  onSelectTicker?: (t: string) => void;
  /** Provenance / meaning tip (Radix DataTip). */
  title?: string;
}) {
  const badgeClass = cn(
    "text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border transition-colors",
    matches ? "cursor-pointer" : "cursor-default",
    TAG_STYLES[type],
  );

  if (!matches) {
    // Never `disabled` alone — drops pointer events. aria-disabled keeps tip hover.
    const btn = (
      <button type="button" aria-disabled className={badgeClass}>{value}</button>
    );
    return title ? <DataTip tip={title}>{btn}</DataTip> : btn;
  }

  // Tip on popover header only — don't nest TooltipTrigger inside PopoverTrigger.
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(badgeClass, "hover:brightness-125")}>{value}</button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0 text-xs bg-zinc-900 border-zinc-600/40" align="start">
        <div className="px-3 py-2 border-b border-amber-500/20 bg-zinc-800/90 flex items-center gap-2">
          <span className={cn("text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border shrink-0", TAG_STYLES[type])}>
            {value}
          </span>
          <span className="text-amber-200/70 text-[11px] min-w-0">
            {title ? (
              <DataTip tip={title}>
                <span className="block truncate">{matches.length} in watchlist</span>
              </DataTip>
            ) : (
              <>{matches.length} ticker{matches.length !== 1 ? "s" : ""} in your watchlist</>
            )}
          </span>
        </div>
        <div className="p-2 flex flex-col gap-0.5 max-h-72 overflow-y-auto">
          {matches.length === 0 ? (
            <span className="text-amber-200/60 italic px-1.5 py-1">No watchlist tickers share this tag (meta may still be filling).</span>
          ) : (
            matches.map(({ ticker: t, companyName }) => (
              <button
                key={t}
                onClick={() => onSelectTicker?.(t)}
                className="w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-zinc-800 transition-colors text-left"
              >
                <span className="font-mono font-bold text-xs text-white">{t}</span>
                {companyName && <span className="text-[11px] text-amber-100 truncate">{companyName}</span>}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export type BreakdownPanelProps = {
  title: ReactNode;
  children?: ReactNode;
  empty?: string;
  /** Span both columns in the 2-col grid. */
  fullWidth?: boolean;
  /** Optional right-side action (e.g. Open dig). */
  action?: ReactNode;
  /** Cap height + scroll only when content is long (charts). Prefer max-h-* over fixed h-* to avoid empty black. */
  scrollMax?: string;
};

export function BreakdownPanel({ title, children, empty, fullWidth, action, scrollMax }: BreakdownPanelProps) {
  return (
    <div
      className={cn(
        // h-auto by default — fixed h-* + items-stretch left empty black under short peer lists.
        "bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-2.5 flex flex-col min-h-0",
        fullWidth && "col-span-2",
      )}
    >
      <div className="flex items-center justify-between mb-1.5 gap-2 shrink-0 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0 text-[11px] font-semibold tracking-wide text-[#d4af37] font-sans">
          {title}
        </div>
        {action}
      </div>
      <div
        className={cn(
          "min-h-0",
          scrollMax ?? "flex-1 overflow-y-auto",
          scrollMax && !/overflow-/.test(scrollMax) && "overflow-y-auto",
        )}
      >
        {children ?? (
          <p className="text-[10px] text-amber-200/40 italic">{empty ?? "No data available."}</p>
        )}
      </div>
    </div>
  );
}
