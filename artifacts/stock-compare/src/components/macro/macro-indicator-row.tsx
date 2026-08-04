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
    ? "bg-amber-500/10"
    : highlight === "recent"
    ? "bg-sky-500/10"
    : highlight === "upcoming"
    ? "bg-yellow-500/10"
    : "bg-zinc-900/70 even:bg-zinc-800/60";

  const labelColor =
    highlight === "recent"
      ? "text-sky-300"
      : highlight === "upcoming"
      ? "text-yellow-400"
      : "text-amber-200/50";

  return (
    <tr
      className={cn("hover:bg-amber-500/10 cursor-pointer transition-colors", rowBg)}
      onClick={onSelect}
    >
      <td className={cn("px-3 py-1.5", labelColor)}>
        <span className="flex items-center gap-1.5">
          {label}
          {highlight === "recent" && (
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 inline-block shrink-0" title="Recently released" />
          )}
          {highlight === "upcoming" && (
            <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 inline-block shrink-0" title="Upcoming this week" />
          )}
        </span>
      </td>
      <td className="px-3 py-1.5 text-right font-medium font-mono text-white">{value}</td>
      <td className={cn("px-3 py-1.5 text-right font-mono", momColor)}>{momDisplay}</td>
      <td className={cn("px-3 py-1.5 text-right font-mono", yoyColor)}>{yoyDisplay}</td>
      <td className="px-3 py-1.5 text-right font-mono text-amber-200/40">
        {date ? fmtMonthYear(date) : "—"}
      </td>
    </tr>
  );
}
