import { ExternalLink } from "lucide-react";

export interface NewsItem {
  title: string;
  link: string;
  publisher: string;
  publishedAt: string | null;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const h = Math.floor(diff / 3_600_000);
  if (h < 1) return "< 1h ago";
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NewsCard({ item }: { item: NewsItem }) {
  if (!item.link) return null;
  return (
    <a
      href={item.link}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-start gap-3 p-3 rounded-lg hover:bg-secondary/40 transition-colors border border-transparent hover:border-border/40 group"
    >
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium leading-snug group-hover:text-primary transition-colors line-clamp-2">
          {item.title}
        </p>
        <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-foreground">
          {item.publisher && <span className="font-medium">{item.publisher}</span>}
          {item.publishedAt && (
            <>
              <span>·</span>
              <span>{timeAgo(item.publishedAt)}</span>
            </>
          )}
        </div>
      </div>
      <ExternalLink className="w-3.5 h-3.5 text-muted-foreground/40 shrink-0 mt-0.5 group-hover:text-primary/60 transition-colors" />
    </a>
  );
}
