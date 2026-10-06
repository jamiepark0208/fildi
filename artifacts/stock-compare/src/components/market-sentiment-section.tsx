import { Calendar, TrendingUp, TrendingDown } from "lucide-react";
import { formatMdYy } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Recommendations } from "./analyst-ratings-section";
import type { ReactNode } from "react";

/** Rewrite ISO YYYY-MM-DD inside free text to m/d/yy. */
function displayDatesInText(text: string): string {
  return text.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (_, y, m, d) =>
    formatMdYy(`${y}-${m}-${d}`),
  );
}

const EARNINGS_LINE = /^(Earnings|Next earnings)/i;

const BULL_GRADE = /\b(strong buy|buy|overweight|outperform|accumulate|positive)\b/gi;
const BEAR_GRADE = /\b(strong sell|sell|underweight|underperform|reduce|negative|avoid)\b/gi;
const NEUTRAL_GRADE = /\b(equal[-\s]?weight|market perform|sector perform|hold|neutral|in[-\s]?line)\b/gi;
const BULL_VERB = /\b(upgraded|upgrade|beat|raised|initiates? coverage)\b/gi;
const BEAR_VERB = /\b(cut|downgraded|downgrade|missed|lowered|slashed)\b/gi;
const RATED_VERB = /\b(rated|maintains|reiterated|initiated)\b/gi;

/**
 * Inline emphasis for case / catalyst lines — same font size, color + weight + underline.
 * Analyst pattern: Firm verb from Grade to Grade (date)
 */
export function StyledCaseText({ text, tone }: { text: string; tone: "bull" | "bear" | "neutral" }) {
  const raw = displayDatesInText(text);
  const analyst = raw.match(
    /^(.+?)\s+(upgraded|cut|rated|downgraded|initiated|maintains|reiterated)(?:\s+from\s+(.+?))?(?:\s+to\s+|\s+)(.+?)(?:\s+\((.+)\))?$/i,
  );

  if (analyst) {
    const [, firm, verb, from, toOrRest, date] = analyst;
    // When there's no "from", group 3 is empty and group 4 is the grade (+ maybe junk).
    const to = (from ? toOrRest : toOrRest)?.trim() ?? "";
    return (
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
          <span className="italic text-muted-foreground"> ({date})</span>
        ) : null}
      </span>
    );
  }

  // Generic: highlight known verbs/grades in metric or news lines
  return (
    <span className={cn("text-[11px] leading-snug", tone === "neutral" ? "text-foreground" : "text-foreground")}>
      {highlightGeneric(raw, tone)}
    </span>
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
      return <span key={i} className="italic text-muted-foreground">{part}</span>;
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
    // Soften body copy slightly vs firm/grade emphasis
    return (
      <span key={i} className={tone === "bull" ? "text-green-100/90" : tone === "bear" ? "text-red-100/90" : "text-foreground"}>
        {part}
      </span>
    );
  });
}

/**
 * Green/red bull–bear cards (+ optional neutral catalysts column).
 */
export function BullBearCases({
  bullBullets,
  bearBullets,
  catalysts,
}: {
  bullBullets: string[];
  bearBullets: string[];
  catalysts?: string[];
}) {
  // Earnings already on Trade ER chip — keep catalysts for other neutrals (news, initiate@Hold, …)
  const catalystLines = (catalysts ?? []).filter((l) => !EARNINGS_LINE.test(l));
  const hasBullets = bullBullets.length > 0 || bearBullets.length > 0;
  const hasCatalysts = catalystLines.length > 0;
  if (!hasBullets && !hasCatalysts) return null;

  return (
    <div
      className={
        hasCatalysts
          ? "grid grid-cols-1 sm:grid-cols-3 gap-2"
          : "grid grid-cols-2 gap-2"
      }
    >
      <div className="border border-green-500/20 rounded-lg p-2 bg-green-500/5">
        <div className="flex items-center gap-1.5 mb-1.5">
          <TrendingUp className="w-3.5 h-3.5 text-green-400" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-green-400">Bull Case</span>
        </div>
        <ul className="space-y-1.5">
          {bullBullets.map((b, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="shrink-0 text-green-500/70 mt-0.5 text-[11px]">▲</span>
              <StyledCaseText text={b} tone="bull" />
            </li>
          ))}
          {bullBullets.length === 0 && (
            <li className="text-[11px] text-foreground/50 italic">No strong bull signals from current metrics</li>
          )}
        </ul>
      </div>

      {hasCatalysts && (
        <div className="border border-[#d4af37]/25 rounded-lg p-2 bg-[#d4af37]/5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <Calendar className="w-3.5 h-3.5 text-[#d4af37]" />
            <span className="text-[10px] font-bold uppercase tracking-widest text-[#d4af37]">Catalysts</span>
          </div>
          <ul className="space-y-1.5">
            {catalystLines.map((line, i) => (
              <li key={i} className="flex gap-1.5">
                <span className="shrink-0 text-[#d4af37]/70 mt-0.5 text-[11px]">•</span>
                <StyledCaseText text={line} tone="neutral" />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border border-red-500/20 rounded-lg p-2 bg-red-500/5">
        <div className="flex items-center gap-1.5 mb-1.5">
          <TrendingDown className="w-3.5 h-3.5 text-red-400" />
          <span className="text-[10px] font-bold uppercase tracking-widest text-red-400">Bear Case</span>
        </div>
        <ul className="space-y-1.5">
          {bearBullets.map((b, i) => (
            <li key={i} className="flex gap-1.5">
              <span className="shrink-0 text-red-500/70 mt-0.5 text-[11px]">▼</span>
              <StyledCaseText text={b} tone="bear" />
            </li>
          ))}
          {bearBullets.length === 0 && (
            <li className="text-[11px] text-foreground/50 italic">No significant bear signals from current metrics</li>
          )}
        </ul>
      </div>
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
      <div className="text-[10px] text-muted-foreground mt-0.5">Based on {total} analyst recommendations</div>
    </div>
  );
}
