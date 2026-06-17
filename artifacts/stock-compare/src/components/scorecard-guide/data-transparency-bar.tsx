import { cn } from "@/lib/utils";

type Props = {
  factset: boolean;
  fmp: boolean;
  fmpRemaining?: number;
};

/** Global connectivity strip below page title */
export function DataTransparencyBar({ factset, fmp, fmpRemaining }: Props) {
  return (
    <p className="text-[10px] text-muted-foreground truncate">
      Peer-ranked · FactSet {factset ? "Active" : "Inactive"} · FMP {fmp ? "Active" : "Inactive"}
      {fmpRemaining != null ? ` (${fmpRemaining} calls left)` : ""}
    </p>
  );
}

export function SourceDot({ active, label }: { active: boolean; label: string }) {
  return (
    <span className={cn("inline-flex items-center gap-0.5", active ? "text-foreground" : "text-muted-foreground")}>
      <span className={active ? "text-green-400" : "text-muted-foreground/50"}>{active ? "●" : "○"}</span>
      {label}
    </span>
  );
}
