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

export function scoreTone(score: number | null | undefined): string {
  if (score == null || !Number.isFinite(score)) return "border-white/40 text-white/70 bg-zinc-800";
  if (score >= 70) return "border-green-400 text-white bg-green-600/40";
  if (score >= 50) return "border-yellow-400 text-white bg-yellow-600/35";
  if (score >= 35) return "border-orange-400 text-white bg-orange-600/35";
  return "border-red-400 text-white bg-red-600/40";
}

export function PillarChip({ label, score, title }: { label: string; score: number | null | undefined; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-baseline gap-1 px-1.5 py-0.5 rounded border text-[11px] font-mono tabular-nums",
        scoreTone(score),
      )}
    >
      <span className="text-[9px] font-bold uppercase tracking-wide font-sans">{label}</span>
      <span className="font-bold">{score != null && Number.isFinite(score) ? score.toFixed(0) : "—"}</span>
    </span>
  );
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
}

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
  news: NewsItem[];
  earningsDate?: string | null;
  earningsHistory?: EarningsQuarter[];
  catalysts?: string[];
  peers?: string[];
  peerIndustry?: string | null;
  peerSector?: string | null;
}

// ── Data fetching ──────────────────────────────────────────────────────────────

export function useBreakdown(ticker: string | null) {
  return useQuery<BreakdownData, Error>({
    queryKey: ["breakdown", ticker],
    queryFn: async () => {
      const res = await fetch(`/api/stocks/breakdown?ticker=${encodeURIComponent(ticker!)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    enabled: !!ticker,
    staleTime: 10 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
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

export const TAG_STYLES: Record<TagType, string> = {
  exchange:  "border-sky-500/30 bg-sky-500/10 text-sky-300 hover:bg-sky-500/20",
  sector:    "border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/20",
  industry:  "border-teal-500/30 bg-teal-500/10 text-teal-300 hover:bg-teal-500/20",
  stockType: "border-amber-500/30 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20",
  beta:      "border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20",
  marketCap: "border-blue-500/30 bg-blue-500/10 text-blue-300 hover:bg-blue-500/20",
};

export function TagBadge({
  type, value, matches, onSelectTicker,
}: {
  type: TagType; value: string;
  matches?: { ticker: string; companyName: string | null }[];
  onSelectTicker?: (t: string) => void;
}) {
  const badgeClass = cn(
    "text-[10px] font-semibold tracking-wide px-2 py-0.5 rounded-full border transition-colors",
    matches ? "cursor-pointer" : "cursor-default",
    TAG_STYLES[type],
  );

  if (!matches) {
    return <button type="button" disabled className={badgeClass}>{value}</button>;
  }

  // Styled to match the Live Monitor intraday regime checkpoint popover (live.tsx).
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
          <span className="text-amber-200/70 text-[11px]">
            {matches.length} ticker{matches.length !== 1 ? "s" : ""} in your watchlist
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
                {companyName && <span className="text-[11px] text-zinc-400 truncate">{companyName}</span>}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export type BreakdownPanelProps = {
  title: string;
  children?: ReactNode;
  empty?: string;
  /** Span both columns in the 2-col grid. */
  fullWidth?: boolean;
  /** Optional right-side action (e.g. Open dig). */
  action?: ReactNode;
  /** Cap height + scroll only when content is long (charts). */
  scrollMax?: string;
};

export function BreakdownPanel({ title, children, empty, fullWidth, action, scrollMax }: BreakdownPanelProps) {
  return (
    <div
      className={cn(
        // h-auto by default — fixed h-full + sibling stretch left empty black in short Peers/Street.
        "bg-zinc-950 border border-[#d4af37]/20 rounded-lg p-2.5 flex flex-col min-h-0",
        fullWidth && "col-span-2",
      )}
    >
      <div className="flex items-center justify-between mb-1.5 gap-2 shrink-0">
        <span className="text-[11px] font-bold tracking-tight text-[#d4af37] truncate">{title}</span>
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
