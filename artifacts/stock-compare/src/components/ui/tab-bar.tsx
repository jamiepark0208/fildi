import { cn } from "@/lib/utils";

// Shared pill-style tab bar — mirrors the primary-nav pattern in top-nav.tsx
// (bg-{color}/15 + text-{color} active pill) so sub-nav controls read as the
// same idiom as the main nav instead of inventing a new tab style per page.
// Each tab can carry its own accent `color` so multi-tab bars stay visually
// distinguishable; omit it to fall back to the default primary accent.

export type TabBarColor = "primary" | "blue" | "violet" | "emerald" | "amber" | "rose" | "cyan" | "fuchsia" | "orange" | "teal";

const ACTIVE_COLOR_CLASSES: Record<TabBarColor, string> = {
  primary: "bg-primary/15 text-primary",
  blue:    "bg-blue-500/15 text-blue-300",
  violet:  "bg-violet-500/15 text-violet-300",
  emerald: "bg-emerald-500/15 text-emerald-300",
  amber:   "bg-amber-500/15 text-amber-300",
  rose:    "bg-rose-500/15 text-rose-300",
  cyan:    "bg-cyan-500/15 text-cyan-300",
  fuchsia: "bg-fuchsia-500/15 text-fuchsia-300",
  orange:  "bg-orange-500/15 text-orange-300",
  teal:    "bg-teal-500/15 text-teal-300",
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
    <div className={cn("flex items-center gap-1", className)}>
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "text-xs font-bold tracking-wide px-3 py-1.5 rounded-md transition-colors",
            active === t.id
              ? ACTIVE_COLOR_CLASSES[t.color ?? "primary"]
              : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
