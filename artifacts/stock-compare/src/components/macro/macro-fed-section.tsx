import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, ExternalLink, Loader2, Newspaper } from "lucide-react";
import { Tooltip as UiTooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { FedMember, BankResearch, NewsArticle } from "./macro-page-types";
import { stanceBadgeClass, stanceLabel } from "./macro-format";

// ── Fed stance group ─────────────────────────────────────────────────────────────

export function FedStanceGroup({
  title,
  hawkish,
  neutral,
  dovish,
}: {
  title: string;
  hawkish: FedMember[];
  neutral: FedMember[];
  dovish: FedMember[];
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">{title}</p>

      {hawkish.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-red-400 uppercase tracking-wider font-semibold">Hawkish ({hawkish.length})</p>
          {hawkish.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
      {neutral.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-yellow-400 uppercase tracking-wider font-semibold">Neutral ({neutral.length})</p>
          {neutral.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
      {dovish.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] text-green-400 uppercase tracking-wider font-semibold">Dovish ({dovish.length})</p>
          {dovish.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
    </div>
  );
}

// ── Fed member scale strip (hawkish ↔ neutral ↔ dovish) ───────────────────────────

const STANCE_DOT_COLOR: Record<FedMember["stance"], string> = {
  hawkish: "bg-red-500 border-red-300",
  neutral: "bg-yellow-500 border-yellow-300",
  dovish: "bg-green-500 border-green-300",
};

const STANCE_DOT_COLOR_NONVOTING: Record<FedMember["stance"], string> = {
  hawkish: "bg-red-950/40 border-red-500/70",
  neutral: "bg-yellow-950/40 border-yellow-500/70",
  dovish: "bg-green-950/40 border-green-500/70",
};

function FedMemberDot({ member }: { member: FedMember }) {
  const colorCls = member.voting ? STANCE_DOT_COLOR[member.stance] : STANCE_DOT_COLOR_NONVOTING[member.stance];
  return (
    <UiTooltip delayDuration={150}>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            "w-3.5 h-3.5 rounded-full border-2 shrink-0 transition-transform hover:scale-125 cursor-pointer",
            colorCls,
          )}
        />
      </TooltipTrigger>
      <TooltipContent
        side="top"
        className="bg-zinc-950 text-white border border-[#d4af37]/25 rounded-md p-2 max-w-[220px] space-y-1"
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className="text-xs font-bold">{member.name}</p>
          <span className={cn("px-1.5 py-0.5 rounded border text-[10px] font-semibold capitalize",
            member.stance === "hawkish" ? "bg-red-500/15 text-red-400 border-red-500/40" :
            member.stance === "dovish" ? "bg-green-500/15 text-green-400 border-green-500/40" :
            "bg-yellow-500/15 text-yellow-400 border-yellow-500/40")}>
            {member.stance}
          </span>
        </div>
        <p className="text-[10px] text-amber-200/50">{member.title} · {member.voting ? "Voting" : "Non-voting"}</p>
        {member.notes && <p className="text-[10px] text-amber-200/40 italic leading-snug">{member.notes}</p>}
        {member.recentChange && <p className="text-[10px] text-sky-300/80 leading-snug">↳ {member.recentChange}</p>}
      </TooltipContent>
    </UiTooltip>
  );
}

export function FedScaleStrip({
  hawkish,
  neutral,
  dovish,
}: {
  hawkish: FedMember[];
  neutral: FedMember[];
  dovish: FedMember[];
}) {
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-3 gap-2 min-h-[24px] items-end">
        <div className="flex flex-wrap gap-1.5 justify-start">
          {hawkish.map((m) => <FedMemberDot key={m.name} member={m} />)}
        </div>
        <div className="flex flex-wrap gap-1.5 justify-center">
          {neutral.map((m) => <FedMemberDot key={m.name} member={m} />)}
        </div>
        <div className="flex flex-wrap gap-1.5 justify-end">
          {dovish.map((m) => <FedMemberDot key={m.name} member={m} />)}
        </div>
      </div>
      <div className="h-1 rounded-full bg-gradient-to-r from-red-500 via-yellow-500 to-green-500" />
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wider font-semibold">
        <span className="text-red-400">Hawkish ({hawkish.length})</span>
        <span className="text-yellow-400">Neutral ({neutral.length})</span>
        <span className="text-green-400">Dovish ({dovish.length})</span>
      </div>
      <div className="flex items-center gap-3 text-[9px] text-amber-200/40">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[#d4af37] border-2 border-[#d4af37]/60 inline-block" /> Voting
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-zinc-950 border-2 border-[#d4af37]/30 inline-block" /> Non-voting
        </span>
      </div>
    </div>
  );
}

export function InitialsAvatar({ name, stance }: { name: string; stance: FedMember["stance"] }) {
  const initials = name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const cls =
    stance === "hawkish"
      ? "bg-red-900/70 text-red-200"
      : stance === "dovish"
      ? "bg-green-900/70 text-green-200"
      : "bg-yellow-900/70 text-yellow-200";
  return (
    <div className={cn("w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold shrink-0", cls)}>
      {initials}
    </div>
  );
}

export function FedMemberCard({ member }: { member: FedMember }) {
  const [photoFailed, setPhotoFailed] = useState(false);

  return (
    <div className="border border-[#d4af37]/20 rounded-md p-2 flex items-start gap-2 bg-zinc-950/60">
      {member.photoUrl && !photoFailed ? (
        <img
          src={member.photoUrl}
          alt={member.name}
          className="w-7 h-7 rounded-full object-cover shrink-0 bg-secondary"
          onError={() => setPhotoFailed(true)}
        />
      ) : (
        <InitialsAvatar name={member.name} stance={member.stance} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className="text-xs font-bold text-white leading-tight">{member.name}</p>
          <span className="text-[10px] text-amber-200/40">· {member.title}</span>
          {member.recentChange && (
            <span className="px-1.5 py-0.5 rounded border text-[9px] font-semibold bg-sky-500/10 text-sky-300 border-sky-500/40">
              Updated
            </span>
          )}
        </div>
        {member.notes && (
          <p className="text-[10px] text-amber-200/50 italic mt-0.5 line-clamp-1">{member.notes}</p>
        )}
        {member.recentChange && (
          <p className="text-[10px] text-sky-300/80 mt-0.5 line-clamp-1">↳ {member.recentChange}</p>
        )}
      </div>
    </div>
  );
}

// ── Bank Research Card ──────────────────────────────────────────────────────────

export function BankCard({ bank }: { bank: BankResearch }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { data: news, isLoading: newsLoading } = useQuery<NewsArticle[]>({
    queryKey: ["bank-news", bank.name],
    queryFn: () =>
      fetch(`/api/macro/bank-news?bank=${encodeURIComponent(bank.name)}`).then((r) => r.json()),
    enabled: isExpanded,
    staleTime: 15 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div
        className="px-2.5 py-2 flex items-center justify-between gap-2 cursor-pointer hover:bg-amber-500/10 transition-colors"
        onClick={() => setIsExpanded((e) => !e)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className={cn(
              "w-7 h-7 rounded flex items-center justify-center text-[10px] font-bold shrink-0",
              stanceBadgeClass(bank.stance)
            )}
          >
            {bank.shortName.slice(0, 4)}
          </div>
          <div className="min-w-0">
            <p className="text-xs font-semibold text-white leading-tight truncate">{bank.name}</p>
            <span className="text-[10px] text-amber-200/40">{bank.rateView}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className={cn(
              "px-1.5 py-0.5 rounded border text-[10px] font-semibold capitalize",
              stanceBadgeClass(bank.stance)
            )}
          >
            {stanceLabel(bank.stance)}
          </span>
          {isExpanded ? (
            <ChevronUp className="h-3.5 w-3.5 text-[#d4af37]/60" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5 text-[#d4af37]/60" />
          )}
        </div>
      </div>

      {/* Summary + news panel */}
      {isExpanded && (
        <div className="border-t border-[#d4af37]/20 px-2.5 py-2 space-y-1.5">
          <p className="text-[11px] text-amber-200/60 leading-snug">{bank.summary}</p>
          <p className="text-[9px] text-amber-200/30">
            Updated {new Date(bank.lastUpdated + "T12:00:00").toLocaleDateString("en-US", {
              month: "short", day: "numeric", year: "numeric",
            })}
          </p>
          <div className="flex items-center gap-1.5 text-[10px] text-[#d4af37]/80 font-semibold uppercase tracking-wide pt-0.5">
            <Newspaper className="h-3 w-3" />
            Recent News
          </div>
          {newsLoading ? (
            <div className="flex items-center gap-1.5 py-1">
              <Loader2 className="h-3 w-3 animate-spin text-[#d4af37]/60" />
              <span className="text-[11px] text-amber-200/50">Fetching news…</span>
            </div>
          ) : !news || news.length === 0 ? (
            <p className="text-[11px] text-amber-200/40 italic py-0.5">No recent articles found.</p>
          ) : (
            <div className="space-y-1">
              {news.map((article, i) => (
                <a
                  key={i}
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-1.5 group"
                >
                  <ExternalLink className="h-3 w-3 text-amber-200/40 shrink-0 mt-0.5 group-hover:text-[#d4af37]" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] text-amber-200/70 leading-snug group-hover:text-[#d4af37] transition-colors line-clamp-2">
                      {article.title}
                    </p>
                    <p className="text-[9px] text-amber-200/30">
                      {article.source}
                      {article.publishedAt ? ` · ${new Date(article.publishedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}` : ""}
                    </p>
                  </div>
                </a>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
