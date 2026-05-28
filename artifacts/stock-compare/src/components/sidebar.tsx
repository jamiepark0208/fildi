import { BarChart2, LayoutDashboard, LineChart, BarChart, Bookmark, Settings } from "lucide-react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export function Sidebar() {
  const [location] = useLocation();

  const navItem = (href: string, icon: React.ReactNode, label: string, disabled = false, soon = false) => {
    const isActive = href === "/" ? location === "/" || location === "" : location.startsWith(href);
    return disabled ? (
      <div className="flex items-center justify-between px-3 py-2 rounded-md text-muted-foreground opacity-40 cursor-not-allowed select-none">
        <div className="flex items-center gap-3">
          {icon}
          <span className="text-sm">{label}</span>
        </div>
        {soon && <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4">Soon</Badge>}
      </div>
    ) : (
      <Link href={href}>
        <div className={cn(
          "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium cursor-pointer transition-colors",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:text-foreground hover:bg-secondary/50"
        )}>
          {icon}
          {label}
        </div>
      </Link>
    );
  };

  return (
    <aside className="fixed inset-y-0 left-0 w-[220px] bg-sidebar border-r border-sidebar-border overflow-y-auto flex flex-col z-50">
      <div className="p-5">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
            <BarChart2 className="w-4 h-4 text-primary-foreground" />
          </div>
          <span className="font-bold tracking-tight text-lg text-foreground">FILDI</span>
        </div>
      </div>

      <div className="px-5 mb-3">
        <div className="h-px bg-sidebar-border w-full" />
      </div>

      <div className="flex-1 px-3 space-y-6 mt-1 pb-6">
        <div>
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 px-3">Main</div>
          <nav className="space-y-0.5">
            {navItem("/", <LayoutDashboard className="w-4 h-4" />, "Dashboard")}
            {navItem("/watchlist", <Bookmark className="w-4 h-4" />, "Watchlist")}
          </nav>
        </div>

        <div>
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 px-3">Analysis</div>
          <nav className="space-y-0.5">
            {navItem("/", <BarChart className="w-4 h-4" />, "Fundamental")}
            {navItem("/technical", <LineChart className="w-4 h-4" />, "Technical", true, true)}
          </nav>
        </div>

        <div>
          <div className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest mb-2 px-3">General</div>
          <nav className="space-y-0.5">
            {navItem("/settings", <Settings className="w-4 h-4" />, "Settings", true)}
          </nav>
        </div>
      </div>
    </aside>
  );
}
