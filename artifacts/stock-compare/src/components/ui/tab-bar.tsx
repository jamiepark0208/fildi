import { cn } from "@/lib/utils";

// Shared pill-style tab bar — mirrors the primary-nav pattern in top-nav.tsx
// (bg-primary/15 + text-primary active pill) so sub-nav controls read as the
// same idiom as the main nav instead of inventing a new tab style per page.

export interface TabBarItem<T extends string> {
  id: T;
  label: string;
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
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
