import { BarChart2, LayoutDashboard, LineChart, FileText, Settings, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

interface SidebarProps {
  onAddTickerClick: () => void;
}

export function Sidebar({ onAddTickerClick }: SidebarProps) {
  return (
    <aside className="fixed inset-y-0 left-0 w-[220px] bg-sidebar border-r border-sidebar-border overflow-y-auto flex flex-col z-50">
      <div className="p-6">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold">
            <BarChart2 className="w-5 h-5" />
          </div>
          <span className="font-bold tracking-tight text-xl text-foreground">FILDI</span>
        </div>
      </div>
      
      <div className="px-6 mb-4">
        <div className="h-px bg-sidebar-border w-full"></div>
      </div>

      <div className="flex-1 px-4 space-y-8 mt-2">
        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Main</div>
          <nav className="space-y-1">
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md bg-primary/10 text-primary font-medium transition-colors">
              <LayoutDashboard className="w-4 h-4" />
              Dashboard
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors opacity-60 cursor-not-allowed">
              <FileText className="w-4 h-4" />
              Watchlist
            </button>
          </nav>
        </div>

        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Analysis</div>
          <nav className="space-y-1">
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-foreground font-medium hover:bg-secondary/50 transition-colors">
              <BarChart2 className="w-4 h-4 text-muted-foreground" />
              Fundamental
            </button>
            <button className="w-full flex items-center justify-between px-3 py-2 rounded-md text-muted-foreground opacity-60 cursor-not-allowed hover:bg-secondary/50 transition-colors">
              <div className="flex items-center gap-3">
                <LineChart className="w-4 h-4" />
                Technical
              </div>
              <Badge variant="secondary" className="text-[9px] px-1.5 py-0 h-4 bg-secondary">Soon</Badge>
            </button>
          </nav>
        </div>

        <div>
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">General</div>
          <nav className="space-y-1">
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/50 transition-colors opacity-60 cursor-not-allowed">
              <Settings className="w-4 h-4" />
              Settings
            </button>
          </nav>
        </div>
      </div>

      <div className="p-4 mt-auto border-t border-sidebar-border/50">
        <button 
          onClick={onAddTickerClick}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-md bg-secondary text-secondary-foreground hover:bg-secondary/80 transition-colors text-sm font-medium"
        >
          <Plus className="w-4 h-4" />
          Add Ticker
        </button>
      </div>
    </aside>
  );
}
