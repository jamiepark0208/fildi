import { cn } from "@/lib/utils";
import { changeColor, inflColor, fmtMonthYear } from "./macro-format";

// ── Macro data table row ─────────────────────────────────────────────────────────

export function MacroRow({
  indicatorKey,
  label,
  value,
  mom,
  momRaw,
  yoy,
  date,
  inflSign,
  isSelected,
  highlight,
  onSelect,
}: {
  indicatorKey: string;
  label: string;
  value: string;
  mom?: number | null;
  momRaw?: string | null;
  yoy?: number | null;
  date?: string | null;
  inflSign?: boolean;
  isSelected?: boolean;
  highlight?: "recent" | "upcoming" | null;
  onSelect?: () => void;
}) {
  const momDisplay =
    momRaw != null
      ? momRaw
      : mom != null
      ? `${mom > 0 ? "+" : ""}${mom.toFixed(2)}`
      : "—";
  const momColor = inflSign ? inflColor(mom ?? null) : changeColor(mom ?? null);
  const yoyDisplay = yoy != null ? `${yoy > 0 ? "+" : ""}${yoy.toFixed(1)}%` : "—";
  const yoyColor = inflSign ? inflColor(yoy ?? null) : changeColor(yoy ?? null);

  const rowBg = isSelected
    ? "bg-primary/10"
    : highlight === "recent"
    ? "bg-blue-900/10"
    : highlight === "upcoming"
    ? "bg-yellow-900/10"
    : "";

  const labelColor =
    highlight === "recent"
      ? "text-blue-300"
      : highlight === "upcoming"
      ? "text-yellow-300"
      : "text-muted-foreground";

  return (
    <tr
      className={cn("hover:bg-secondary/30 cursor-pointer transition-colors", rowBg)}
      onClick={onSelect}
    >
      <td className={cn("px-4 py-2", labelColor)}>
        <span className="flex items-center gap-1.5">
          {label}
          {highlight === "recent" && (
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 inline-block shrink-0" title="Recently released" />
          )}
          {highlight === "upcoming" && (
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 inline-block shrink-0" title="Upcoming this week" />
          )}
        </span>
      </td>
      <td className="px-3 py-2 text-right font-medium">{value}</td>
      <td className={cn("px-3 py-2 text-right", momColor)}>{momDisplay}</td>
      <td className={cn("px-3 py-2 text-right", yoyColor)}>{yoyDisplay}</td>
      <td className="px-4 py-2 text-right text-muted-foreground/70">
        {date ? fmtMonthYear(date) : "—"}
      </td>
    </tr>
  );
}
