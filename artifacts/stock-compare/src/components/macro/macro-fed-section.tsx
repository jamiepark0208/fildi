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
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground font-medium">{title}</p>

      {hawkish.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-red-400 uppercase tracking-wider font-semibold">Hawkish ({hawkish.length})</p>
          {hawkish.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
      {neutral.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] text-yellow-400 uppercase tracking-wider font-semibold">Neutral ({neutral.length})</p>
          {neutral.map((m) => <FedMemberCard key={m.name} member={m} />)}
        </div>
      )}
      {dovish.length > 0 && (
        <div className="space-y-1.5">
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
        className="bg-popover text-popover-foreground border border-border rounded-md p-2.5 max-w-[220px] space-y-1"
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          <p className="text-xs font-bold">{member.name}</p>
          <span className={cn("text-[9px] px-1.5 py-0.5 rounded-full font-medium capitalize",
            member.stance === "hawkish" ? "bg-red-500/15 text-red-400" :
            member.stance === "dovish" ? "bg-green-500/15 text-green-400" :
            "bg-yellow-500/15 text-yellow-400")}>
            {member.stance}
          </span>
        </div>
        <p className="text-[10px] text-muted-foreground">{member.title} · {member.voting ? "Voting" : "Non-voting"}</p>
        {member.notes && <p className="text-[10px] text-muted-foreground/90 italic leading-snug">{member.notes}</p>}
        {member.recentChange && <p className="text-[10px] text-blue-300/90 leading-snug">↳ {member.recentChange}</p>}
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
    <div className="space-y-2.5">
      <div className="grid grid-cols-3 gap-2 min-h-[28px] items-end">
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
      <div className="h-1.5 rounded-full bg-gradient-to-r from-red-500 via-yellow-500 to-green-500" />
      <div className="flex items-center justify-between text-[10px] text-muted-foreground uppercase tracking-wider font-semibold">
        <span className="text-red-400">Hawkish ({hawkish.length})</span>
        <span className="text-yellow-400">Neutral ({neutral.length})</span>
        <span className="text-green-400">Dovish ({dovish.length})</span>
      </div>
      <div className="flex items-center gap-3 text-[9px] text-muted-foreground/70">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-slate-400 border-2 border-slate-200 inline-block" /> Voting
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-slate-950/40 border-2 border-slate-500/70 inline-block" /> Non-voting
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
    <div className="border border-border rounded-md p-2.5 flex items-start gap-2.5">
      {member.photoUrl && !photoFailed ? (
        <img
          src={member.photoUrl}
          alt={member.name}
          className="w-9 h-9 rounded-full object-cover shrink-0 bg-secondary"
          onError={() => setPhotoFailed(true)}
        />
      ) : (
        <InitialsAvatar name={member.name} stance={member.stance} />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-bold leading-tight">{member.name}</p>
          {member.recentChange && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-300 border border-blue-700">
              Updated
            </span>
          )}
        </div>
        <p className="text-[10px] text-muted-foreground">{member.title}</p>
        {member.notes && (
          <p className="text-[11px] text-muted-foreground/80 italic mt-0.5 line-clamp-2">{member.notes}</p>
        )}
        {member.recentChange && (
          <p className="text-[10px] text-blue-300/80 mt-0.5">↳ {member.recentChange}</p>
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

  const bg =
    bank.stance === "bullish"
      ? "border-green-900/40 bg-green-900/5"
      : bank.stance === "bearish"
      ? "border-red-900/40 bg-red-900/5"
      : "border-border";

  return (
    <div className={cn("border rounded-lg overflow-hidden", bg)}>
      <div
        className="p-3 space-y-2 cursor-pointer hover:bg-secondary/10 transition-colors"
        onClick={() => setIsExpanded((e) => !e)}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <div
              className={cn(
                "w-10 h-10 rounded-lg flex items-center justify-center text-sm font-bold mb-1",
                stanceBadgeClass(bank.stance)
              )}
            >
              {bank.shortName.slice(0, 4)}
            </div>
            <p className="text-xs font-semibold leading-tight">{bank.name}</p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded-full font-medium capitalize",
                stanceBadgeClass(bank.stance)
              )}
            >
              {stanceLabel(bank.stance)}
            </span>
            {isExpanded ? (
              <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            )}
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground font-medium">{bank.rateView}</p>
        <p className="text-[9px] text-muted-foreground/50">
          {new Date(bank.lastUpdated + "T12:00:00").toLocaleDateString("en-US", {
            month: "short", day: "numeric", year: "numeric",
          })}
        </p>
      </div>

      {/* Summary + news panel */}
      {isExpanded && (
        <div className="border-t border-border px-3 py-2 space-y-2 bg-secondary/10">
          <p className="text-[11px] text-muted-foreground/80 leading-relaxed">{bank.summary}</p>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground font-medium uppercase tracking-wide pt-1">
            <Newspaper className="h-3 w-3" />
            Recent News
          </div>
          {newsLoading ? (
            <div className="flex items-center gap-1.5 py-2">
              <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
              <span className="text-[11px] text-muted-foreground">Fetching news…</span>
            </div>
          ) : !news || news.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic py-1">No recent articles found.</p>
          ) : (
            <div className="space-y-1.5">
              {news.map((article, i) => (
                <a
                  key={i}
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-1.5 group"
                >
                  <ExternalLink className="h-3 w-3 text-muted-foreground/50 shrink-0 mt-0.5 group-hover:text-primary" />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] leading-snug group-hover:text-primary transition-colors line-clamp-2">
                      {article.title}
                    </p>
                    <p className="text-[9px] text-muted-foreground/50">
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
