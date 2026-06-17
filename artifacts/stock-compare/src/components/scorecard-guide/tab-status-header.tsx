import { cn } from "@/lib/utils";

type Props = {
  text: string;
  warn?: boolean;
};

/** Per-tab timeliness / coverage strip */
export function TabStatusHeader({ text, warn }: Props) {
  return (
    <p className={cn(
      "text-[10px] font-mono tabular-nums mb-2",
      warn ? "text-amber-500" : "text-muted-foreground",
    )}>
      {text}
    </p>
  );
}

export type TabStatusHeaderProps = Props;
