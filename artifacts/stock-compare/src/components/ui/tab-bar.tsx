import { cn } from "@/lib/utils";

// Shared pill-style tab bar — mirrors the primary-nav pattern in top-nav.tsx
// (bg-{color}/15 + text-{color} active pill) so sub-nav controls read as the
// same idiom as the main nav instead of inventing a new tab style per page.
// Each tab can carry its own accent `color` so multi-tab bars stay visually
// distinguishable; omit it to fall back to the default primary accent.

export type TabBarColor = "primary" | "blue" | "violet" | "emerald" | "amber" | "rose" | "cyan" | "fuchsia" | "orange" | "teal";

// Solid fill + matching border + shadow so the active tab reads as clearly "selected"
// rather than a faint tint indistinguishable from hover state.
const ACTIVE_COLOR_CLASSES: Record<TabBarColor, string> = {
  primary: "bg-primary/25 text-primary border-primary/40 shadow-sm shadow-primary/10",
  blue:    "bg-blue-500/25 text-blue-200 border-blue-500/40 shadow-sm shadow-blue-500/10",
  violet:  "bg-violet-500/25 text-violet-200 border-violet-500/40 shadow-sm shadow-violet-500/10",
  emerald: "bg-emerald-500/25 text-emerald-200 border-emerald-500/40 shadow-sm shadow-emerald-500/10",
  amber:   "bg-amber-500/25 text-amber-200 border-amber-500/40 shadow-sm shadow-amber-500/10",
  rose:    "bg-rose-500/25 text-rose-200 border-rose-500/40 shadow-sm shadow-rose-500/10",
  cyan:    "bg-cyan-500/25 text-cyan-200 border-cyan-500/40 shadow-sm shadow-cyan-500/10",
  fuchsia: "bg-fuchsia-500/25 text-fuchsia-200 border-fuchsia-500/40 shadow-sm shadow-fuchsia-500/10",
  orange:  "bg-orange-500/25 text-orange-200 border-orange-500/40 shadow-sm shadow-orange-500/10",
  teal:    "bg-teal-500/25 text-teal-200 border-teal-500/40 shadow-sm shadow-teal-500/10",
};

export interface TabBarItem<T extends string> {
  id: T;
  label: string;
  color?: TabBarColor;
}

interface TabBarProps<T extends string> {
  tabs: TabBarItem<T>[];
  active: T;
  onChange: (id: T) => void;
  className?: string;
}

export function TabBar<T extends string>({ tabs, active, onChange, className }: TabBarProps<T>) {
  return (
    <div className={cn("inline-flex items-center gap-1 p-1 rounded-lg bg-muted/30 border border-border/50", className)}>
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "text-xs font-bold tracking-wide px-3 py-1.5 rounded-md border border-transparent transition-colors",
            active === t.id
              ? ACTIVE_COLOR_CLASSES[t.color ?? "primary"]
              : "text-foreground/60 hover:text-foreground hover:bg-background/60"
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
