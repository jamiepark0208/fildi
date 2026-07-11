import {
  BarChart2, Bookmark, BriefcaseBusiness, Trophy, Globe, User, Settings as SettingsIcon,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { prefetchRouteChunk } from "@/lib/prefetch-policy";

export const TOPNAV_H = 56;

type NavItem = {
  id: string;
  href: string;
  label: string;
  icon: typeof Bookmark;
  adminOnly?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { id: "watchlist", href: "/watchlist",  label: "Watchlist",  icon: Bookmark },
  // adminOnly is intentional, not a leftover — enh/8 Phase A1 (unlock nav for
  // everyone) is deferred until the regular-user manual-entry experience in
  // portfolio.tsx is solidified (bug/14, 2026-07-11). Don't "fix" this without
  // checking enh/8's status first.
  { id: "portfolio", href: "/portfolio",  label: "Portfolio",  icon: BriefcaseBusiness, adminOnly: true },
  { id: "rankings",  href: "/rankings",   label: "Rankings",   icon: Trophy },
  { id: "macro",     href: "/macro",      label: "Macro",      icon: Globe },
  { id: "profile",   href: "/profile/me", label: "My Profile", icon: User },
  { id: "settings",  href: "/settings",   label: "Settings",   icon: SettingsIcon },
];

export function TopNav() {
  const [location] = useLocation();
  const { isAdmin } = useAuth();

  const isActive = (href: string) =>
    href === "/" ? location === "/" || location === "" : location.startsWith(href);

  const visibleItems = NAV_ITEMS.filter(item => !item.adminOnly || isAdmin);

  return (
    <header className="fixed inset-x-0 top-0 h-14 bg-sidebar border-b border-sidebar-border flex items-center px-4 gap-1 z-50">
      <Link href="/feed">
        <div
          className="w-8 h-8 rounded-md bg-primary flex items-center justify-center shrink-0 cursor-pointer mr-3"
          title="Feed"
          onMouseEnter={() => prefetchRouteChunk("feed")}
        >
          <BarChart2 className="w-4 h-4 text-primary-foreground" />
        </div>
      </Link>

      <nav className="flex items-center gap-1">
        {visibleItems.map(item => {
          const Icon = item.icon;
          const active = isActive(item.href);
          return (
            <Link key={item.id} href={item.href}>
              <div
                onMouseEnter={() => prefetchRouteChunk(item.href.replace(/^\//, ""))}
                className={cn(
                  "flex flex-col items-center justify-center gap-0.5 px-3 py-1 rounded-md cursor-pointer transition-colors min-w-[64px]",
                  active
                    ? "bg-primary/15 text-white"
                    : "text-white/70 hover:text-white hover:bg-white/8"
                )}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="text-[10px] font-medium leading-none whitespace-nowrap">{item.label}</span>
              </div>
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
