import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMdYy } from "@/lib/format";

export interface NewsItem {
  title: string;
  link?: string;
  publisher: string;
  publishedAt: string | null;
  source?: "desk" | "yahoo";
}

export function NewsCard({ item, compact = false }: { item: NewsItem; compact?: boolean }) {
  if (!item.link) return null;
  const stamp = item.publishedAt ? formatMdYy(item.publishedAt) : null;
  return (
    <a
      href={item.link}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "flex items-start gap-2 rounded-md hover:bg-[#d4af37]/10 transition-colors border border-transparent hover:border-[#d4af37]/30 group",
        compact ? "p-1.5 gap-1.5" : "p-3 gap-3",
      )}
    >
      <div className="flex-1 min-w-0">
        <p
          className={cn(
            "font-semibold leading-snug text-white group-hover:text-[#d4af37] transition-colors line-clamp-2",
            compact ? "text-[12px]" : "text-sm",
          )}
        >
          {item.title}
        </p>
        <div className={cn("flex items-center gap-1.5 mt-0.5 text-white/75 font-medium", compact ? "text-[10px]" : "text-[11px] mt-1")}>
          {item.publisher && <span className="truncate">{item.publisher}</span>}
          {stamp && (
            <>
              <span className="text-amber-100/70">·</span>
              <span className="shrink-0 font-mono tabular-nums text-white">{stamp}</span>
            </>
          )}
        </div>
      </div>
      <ExternalLink className={cn("text-amber-100/70 shrink-0 mt-0.5 group-hover:text-[#d4af37] transition-colors", compact ? "w-3 h-3" : "w-3.5 h-3.5")} />
    </a>
  );
}
