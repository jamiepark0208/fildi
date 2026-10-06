import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";

export interface NewsItem {
  title: string;
  link?: string;
  publisher: string;
  publishedAt: string | null;
  source?: "desk" | "yahoo";
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "< 1h ago";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NewsCard({ item, compact = false }: { item: NewsItem; compact?: boolean }) {
  if (!item.link) return null;
  return (
    <a
      href={item.link}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-start gap-2 rounded-md hover:bg-secondary/40 transition-colors border border-transparent hover:border-border/40 group",
        compact ? "p-1.5 gap-1.5" : "p-3 gap-3",
      )}
    >
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "font-medium leading-snug group-hover:text-primary transition-colors line-clamp-2",
            compact ? "text-[10px]" : "text-sm",
          )}
        >
          {item.title}
        </p>
        <div className={cn("flex items-center gap-1 mt-0.5 text-foreground", compact ? "text-[9px]" : "text-[11px] mt-1.5 gap-1.5")}>
          {item.publisher && <span className="font-medium truncate">{item.publisher}</span>}
          {item.publishedAt && (
            <>
              <span>·</span>
              <span className="shrink-0">{timeAgo(item.publishedAt)}</span>
            </>
          )}
        </div>
      </div>
      <ExternalLink className={cn("text-muted-foreground/40 shrink-0 mt-0.5 group-hover:text-primary/60 transition-colors", compact ? "w-3 h-3" : "w-3.5 h-3.5")} />
    </a>
  );
}
