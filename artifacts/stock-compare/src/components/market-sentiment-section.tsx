import { Calendar, TrendingUp, TrendingDown } from "lucide-react";
import { formatMdYy } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Recommendations } from "./analyst-ratings-section";
import type { ReactNode } from "react";
import { DataTip } from "./data-tip";
import { caseLineTip, formatDerivedTip, type MetricTipCtx } from "@/lib/provenance-display";

/** Rewrite ISO YYYY-MM-DD inside free text to m/d/yy. */
function displayDatesInText(text: string): string {
  return text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) =>
    formatMdYy(`${y}-${m}-${d}`),
  );
}

const EARNINGS_LINE = /^(Earnings|Next earnings)/i;

// Non-capturing groups only — String.split includes every capture; nested (...)
// was duplicating tokens into "NegativeNegative" / "MissedMissed" in the UI.
const BULL_GRADE = /\b(?:strong buy|buy|overweight|outperform|accumulate|positive)\b/gi;
const BEAR_GRADE = /\b(?:strong sell|sell|underweight|underperform|reduce|negative|avoid)\b/gi;
const NEUTRAL_GRADE = /\b(?:equal[-\s]?weight|market perform|sector perform|hold|neutral|in[-\s]?line)\b/gi;
const BULL_VERB = /\b(?:upgraded|upgrade|beat|raised|initiates? coverage)\b/gi;
const BEAR_VERB = /\b(?:cut|downgraded|downgrade|missed|lowered|slashed)\b/gi;
const RATED_VERB = /\b(?:rated|maintains|reiterated|initiated)\b/gi;

/**
 * Inline emphasis for case / catalyst lines — same font size, color + weight + underline.
 * Analyst pattern: Firm verb from Grade to Grade (date)
 */
export function StyledCaseText({
  text,
  tone,
  metrics,
}: {
  text: string;
  tone: "bull" | "bear" | "neutral";
  metrics?: MetricTipCtx | null;
}) {
  const raw = displayDatesInText(text);
  const lineTip = caseLineTip(raw, metrics ?? {});
  const analyst = raw.match(
    /^(.+?)\s+(upgraded|cut|rated|downgraded|initiated|maintains|reiterated)(?:\s+from\s+(.+?))?(?:\s+to\s+|\s+)(.+?)(?:\s+\((.+)\))?$/i,
  );

  if (analyst) {
    const [, firm, verb, from, toOrRest, date] = analyst;
    // When there's no "from", group 3 is empty and group 4 is the grade (+ maybe junk).
    const to = (from ? toOrRest : toOrRest)?.trim() ?? "";
    const actionTip = formatDerivedTip({
      label: "Analyst action",
      kind: "sourced",
      source: "yahoo / fmp / headline",
      asOf: date ? undefined : null,
      extra: date ? `event ${date}` : "rating event — not a computed metric",
    });
    return (
      <DataTip tip={actionTip}>
        <span className="text-[11px] text-foreground leading-snug">
          <span className="font-semibold text-foreground">{firm}</span>{" "}
          <span
            className={cn(
              "font-semibold underline underline-offset-2",
              /^cut|downgrad/i.test(verb!) ? "text-red-400 decoration-red-400/60" :
              /^upgrad/i.test(verb!) ? "text-green-400 decoration-green-400/60" :
              "text-amber-200/90 decoration-amber-400/40",
            )}
          >
            {verb}
          </span>
          {from ? (
            <>
              {" from "}
              <GradeChip grade={from} />
              {" to "}
              <GradeChip grade={to} />
            </>
          ) : (
            <>
              {" "}
              <GradeChip grade={to} />
            </>
          )}
          {date ? (
            <span className="font-mono text-white"> ({date})</span>
          ) : null}
        </span>
      </DataTip>
    );
  }

  // Whole line tip (raw + caveats); numbers share the same tip.
  return (
    <DataTip tip={lineTip}>
      <span className="text-[11px] leading-snug text-foreground">
        {highlightGeneric(raw, tone)}
      </span>
    </DataTip>
  );
}

function GradeChip({ grade }: { grade: string }) {
  const lean =
    /^(strong buy|buy|overweight|outperform|accumulate|positive)$/i.test(grade.trim()) ? "bull" :
    /^(strong sell|sell|underweight|underperform|reduce|negative|avoid)$/i.test(grade.trim()) ? "bear" :
    "neutral";
  return (
    <span
      className={cn(
        "font-bold",
        lean === "bull" && "text-green-400",
        lean === "bear" && "text-red-400",
        lean === "neutral" && "text-amber-200/90 italic",
      )}
    >
      {grade}
    </span>
  );
}

function highlightGeneric(text: string, tone: "bull" | "bear" | "neutral"): ReactNode {
  // Split on grade/verb tokens while keeping delimiters
  const pattern = new RegExp(
    `(${BULL_GRADE.source}|${BEAR_GRADE.source}|${NEUTRAL_GRADE.source}|${BULL_VERB.source}|${BEAR_VERB.source}|${RATED_VERB.source}|\\(\\d{1,2}\\/\\d{1,2}\\/\\d{2}\\)|\\(\\d{4}-\\d{2}-\\d{2}\\))`,
    "gi",
  );
  const parts = text.split(pattern);
  return parts.map((part, i) => {
    if (!part) return null;
    if (/^\(\d/.test(part)) {
      return <span key={i} className="font-mono text-white">{part}</span>;
    }
    if (BULL_GRADE.test(part) || BULL_VERB.test(part)) {
      BULL_GRADE.lastIndex = 0; BULL_VERB.lastIndex = 0;
      const isVerb = BULL_VERB.test(part); BULL_VERB.lastIndex = 0;
      return (
        <span
          key={i}
          className={cn("text-green-400 font-semibold", isVerb && "underline underline-offset-2 decoration-green-400/50")}
        >
          {part}
        </span>
      );
    }
    if (BEAR_GRADE.test(part) || BEAR_VERB.test(part)) {
      BEAR_GRADE.lastIndex = 0; BEAR_VERB.lastIndex = 0;
      const isVerb = BEAR_VERB.test(part); BEAR_VERB.lastIndex = 0;
      return (
        <span
          key={i}
          className={cn("text-red-400 font-semibold", isVerb && "underline underline-offset-2 decoration-red-400/50")}
        >
          {part}
        </span>
      );
    }
    if (NEUTRAL_GRADE.test(part) || RATED_VERB.test(part)) {
      NEUTRAL_GRADE.lastIndex = 0; RATED_VERB.lastIndex = 0;
      return <span key={i} className="text-amber-200/90 italic font-medium">{part}</span>;
    }
    return (
      <span key={i} className={tone === "bull" ? "text-green-100/90" : tone === "bear" ? "text-red-100/90" : "text-foreground"}>
        {/* Numbers already covered by outer DataTip — skip nested tips */}
        {part}
      </span>
    );
  });
}

/**
 * Green/red bull–bear cards (+ optional neutral catalysts column).
 */
const HAS_DATE = /\(\d{1,2}\/\d{1,2}\/\d{2}\)|\(\d{4}-\d{2}-\d{2}\)| on \d{4}-\d{2}-\d{2}\b/;

/** Metric-ratio lines have no event date — stamp with fundamentals as-of. */
function withAsOf(line: string, asOfMdYy: string | null | undefined): string {
  if (!asOfMdYy || HAS_DATE.test(line)) return line;
  return `${line} (${asOfMdYy})`;
}

export function BullBearCases({
  bullBullets,
  bearBullets,
  catalysts,
  metrics,
  eventBulletsGeneratedAt,
  metricsAsOf,
}: {
  bullBullets: string[];
  bearBullets: string[];
  catalysts?: string[];
  /** For tip caveats (tiny-base growth, NI vs margin). */
  metrics?: MetricTipCtx | null;
  /** When trigger event-bullets last wrote (earnings/analyst/±5% vs SPY). Quiet rows expire at 7d. */
  eventBulletsGeneratedAt?: string | null;
  /** Fundamentals as-of for metric-derived bull/bear lines (not event catalysts). */
  metricsAsOf?: string | null;
}) {
  // Earnings already on Trade ER chip — keep catalysts for other neutrals (news, initiate@Hold, …)
  const catalystLines = (catalysts ?? []).filter((l) => !EARNINGS_LINE.test(l));
  const asOfMd = metricsAsOf ? formatMdYy(metricsAsOf) : null;
  const bullDated = bullBullets.map((b) => withAsOf(b, asOfMd));
  const bearDated = bearBullets.map((b) => withAsOf(b, asOfMd));
  const hasBullets = bullDated.length > 0 || bearDated.length > 0;
  const hasCatalysts = catalystLines.length > 0;
  if (!hasBullets && !hasCatalysts) return null;

  const eventAgeDays = eventBulletsGeneratedAt
    ? Math.floor((Date.now() - Date.parse(eventBulletsGeneratedAt)) / 86_400_000)
    : null;
  const eventStamp =
    eventBulletsGeneratedAt && eventAgeDays != null && Number.isFinite(eventAgeDays)
      ? formatMdYy(eventBulletsGeneratedAt)
      : null;
  const eventStale = eventAgeDays != null && eventAgeDays >= 5;

  const stampEl = eventStamp ? (
    <DataTip tip="Batch stamp for same-day event-bullets (earnings / rating change / ≥5% vs SPY). Each analyst line should also carry its own m/d/yy.">
      <p
        className={cn(
          "text-[9px] font-mono tabular-nums text-white",
          eventStale && "text-amber-200",
        )}
      >
        events {eventStamp}{eventStale ? " · stale" : ""}
      </p>
    </DataTip>
  ) : null;

  return (
    <div className="space-y-0.5">
      <div
        className={
          hasCatalysts
            ? "grid grid-cols-1 sm:grid-cols-3 gap-1.5"
            : "grid grid-cols-2 gap-1.5"
        }
      >
        <div className="border border-emerald-500/35 rounded-md p-1.5 bg-zinc-950">
          <div className="flex items-center gap-1 mb-1">
            <TrendingUp className="w-3 h-3 text-emerald-400" />
            <span className="text-[9px] font-bold uppercase tracking-widest text-white">Bull Case</span>
          </div>
          <ul className="space-y-1">
            {bullDated.map((b, i) => (
              <li key={i} className="flex gap-1">
                <span className="shrink-0 text-green-500/70 mt-0.5 text-[10px]">▲</span>
                <StyledCaseText text={b} tone="bull" metrics={metrics} />
              </li>
            ))}
            {bullDated.length === 0 && (
              <li className="text-[10px] text-foreground/50 italic">No strong bull signals from current metrics</li>
            )}
          </ul>
        </div>

        {hasCatalysts && (
          <div className="border border-[#d4af37]/40 rounded-md p-1.5 bg-zinc-950 flex flex-col min-h-0">
            <div className="flex items-center gap-1 mb-1">
              <Calendar className="w-3 h-3 text-[#d4af37]" />
              <span className="text-[9px] font-bold uppercase tracking-widest text-white">Catalysts</span>
            </div>
            <ul className="space-y-1 flex-1">
              {catalystLines.map((line, i) => (
                <li key={i} className="flex gap-1">
                  <span className="shrink-0 text-[#d4af37]/70 mt-0.5 text-[10px]">•</span>
                  <StyledCaseText text={line} tone="neutral" metrics={metrics} />
                </li>
              ))}
            </ul>
            {stampEl && (
              <div className="mt-1 pt-0.5 border-t border-[#d4af37]/20 flex justify-end">{stampEl}</div>
            )}
          </div>
        )}

        <div className="border border-rose-500/40 rounded-md p-1.5 bg-zinc-950">
          <div className="flex items-center gap-1 mb-1">
            <TrendingDown className="w-3 h-3 text-rose-400" />
            <span className="text-[9px] font-bold uppercase tracking-widest text-white">Bear Case</span>
          </div>
          <ul className="space-y-1">
            {bearDated.map((b, i) => (
              <li key={i} className="flex gap-1">
                <span className="shrink-0 text-red-500/70 mt-0.5 text-[10px]">▼</span>
                <StyledCaseText text={b} tone="bear" metrics={metrics} />
              </li>
            ))}
            {bearDated.length === 0 && (
              <li className="text-[10px] text-foreground/50 italic">No significant bear signals from current metrics</li>
            )}
          </ul>
        </div>
      </div>
      {!hasCatalysts && stampEl ? <div className="flex justify-end px-0.5">{stampEl}</div> : null}
    </div>
  );
}

/** Wall St. consensus bar only — bull/bear cases live in `BullBearCases` at memo top. */
export function MarketSentimentSection({
  recs,
}: {
  recs: Recommendations | null;
  /** @deprecated ignored — use BullBearCases at breakdown top */
  bullBullets?: string[];
  bearBullets?: string[];
  catalysts?: string[];
}) {
  const total = recs ? recs.strongBuy + recs.buy + recs.hold + recs.sell + recs.strongSell : 0;
  if (total <= 0) return null;

  const bullPct = Math.round(((recs!.strongBuy + recs!.buy) / total) * 100);
  const neutralPct = Math.round((recs!.hold / total) * 100);
  const bearPct = 100 - bullPct - neutralPct;

  return (
    <div className="pb-1">
      <div className="text-[10px] text-foreground uppercase tracking-widest mb-1.5">Wall St. Consensus</div>
      <div className="flex h-2.5 rounded-full overflow-hidden gap-px">
        {bullPct > 0 && (
          <div className="bg-green-500/80 transition-all" style={{ width: `${bullPct}%` }} />
        )}
        {neutralPct > 0 && (
          <div className="bg-yellow-500/60 transition-all" style={{ width: `${neutralPct}%` }} />
        )}
        {bearPct > 0 && (
          <div className="bg-red-500/70 transition-all" style={{ width: `${bearPct}%` }} />
        )}
      </div>
      <div className="flex justify-between mt-1.5 text-[11px]">
        <span className="text-green-400 font-semibold">{bullPct}% Bullish</span>
        <span className="text-yellow-400/80">{neutralPct}% Neutral</span>
        <span className="text-red-400 font-semibold">{bearPct}% Bearish</span>
      </div>
      <div className="text-[10px] text-amber-100 mt-0.5">Based on {total} analyst recommendations</div>
    </div>
  );
}
