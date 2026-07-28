import { useState } from "react";
import {
  BarChart2, Bookmark, BriefcaseBusiness, Trophy, Globe, User, Settings as SettingsIcon,
  Activity,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";
import { prefetchRouteChunk } from "@/lib/prefetch-policy";

export const TOPNAV_H = 56;

type NavItem = {
  id: string;
  href: string;
  label: string;
  icon: typeof Bookmark;
  color: string;
  adminOnly?: boolean;
};

const LEFT_NAV_ITEMS: NavItem[] = [
  { id: "watchlist", href: "/watchlist",  label: "Watchlist",  icon: Bookmark,          color: "#22d3ee" }, // cyan
  // adminOnly is intentional, not a leftover — enh/8 Phase A1 (unlock nav for
  // everyone) is deferred until the regular-user manual-entry experience in
  // portfolio.tsx is solidified (bug/14, 2026-07-11). Don't "fix" this without
  // checking enh/8's status first.
  { id: "portfolio", href: "/portfolio",  label: "Portfolio",  icon: BriefcaseBusiness, color: "#34d399", adminOnly: true }, // emerald
  { id: "rankings",  href: "/rankings",   label: "Rankings",   icon: Trophy,            color: "#fbbf24" }, // gold
  { id: "macro",     href: "/macro",      label: "Macro",      icon: Globe,             color: "#a78bfa" }, // violet
  { id: "live",      href: "/live",       label: "Live",       icon: Activity,          color: "#fb7185" }, // rose
];

const RIGHT_NAV_ITEMS: NavItem[] = [
  { id: "profile",   href: "/profile/me", label: "Profile",    icon: User,          color: "#f472b6" }, // pink
  { id: "settings",  href: "/settings",   label: "Settings",   icon: SettingsIcon,  color: "#2dd4bf" }, // teal
];

async function apiFeed(path: string, opts?: RequestInit) {
  const r = await fetch(`/api/feed${path}`, { credentials: "include", ...opts });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon;
  return (
    <Link href={item.href}>
      <div
        onMouseEnter={() => prefetchRouteChunk(item.href.replace(/^\//, ""))}
        className={cn(
          "flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-md cursor-pointer transition-all",
          "min-w-[64px]",
          active ? "bg-white/10" : "hover:bg-white/5",
        )}
        style={active ? { boxShadow: `inset 0 0 0 1px ${item.color}40` } : undefined}
      >
        <Icon
          className="w-5 h-5 shrink-0 transition-opacity"
          strokeWidth={2.5}
          style={{ color: item.color, opacity: active ? 1 : 0.75, filter: active ? `drop-shadow(0 0 4px ${item.color}80)` : undefined }}
        />
        <span className={cn("text-xs font-bold leading-none whitespace-nowrap", active ? "text-white" : "text-white/70")}>
          {item.label}
        </span>
      </div>
    </Link>
  );
}

function FindUserSearch() {
  const { user: me } = useAuth();
  const [, navigate] = useLocation();
  const [userSearch, setUserSearch] = useState("");
  const [userDropdownOpen, setUserDropdownOpen] = useState(false);

  const { data: allUsers = [] } = useQuery<{ username: string; avatarUrl: string | null }[]>({
    queryKey: ["feed", "users"],
    queryFn: () => apiFeed("/users"),
    staleTime: 60000,
  });

  const filteredUsers = userSearch.trim()
    ? allUsers.filter(u => u.username.toLowerCase().includes(userSearch.toLowerCase()))
    : allUsers;

  function goToUser(uname: string) {
    setUserSearch("");
    setUserDropdownOpen(false);
    navigate(`/profile/${uname}`);
  }

  return (
    <div className="relative w-full max-w-sm">
      <input
        value={userSearch}
        onChange={e => setUserSearch(e.target.value)}
        onFocus={() => setUserDropdownOpen(true)}
        onBlur={() => setTimeout(() => setUserDropdownOpen(false), 150)}
        placeholder="Find user…"
        className="w-full bg-white border border-white/20 rounded-full px-4 py-1.5 text-sm text-black placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary"
      />
      {userDropdownOpen && filteredUsers.length > 0 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-xl overflow-hidden">
          {filteredUsers.map(u => (
            <button
              key={u.username}
              onMouseDown={() => goToUser(u.username)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/40 transition-colors text-left"
            >
              <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary shrink-0">
                {u.avatarUrl
                  ? <img src={u.avatarUrl} alt={u.username} className="w-5 h-5 rounded-full object-cover" />
                  : u.username[0]?.toUpperCase()}
              </div>
              <span className="font-medium text-foreground">{u.username}</span>
              {u.username === me?.username && <span className="ml-auto text-[10px] text-muted-foreground">you</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function TopNav() {
  const [location] = useLocation();
  const { isAdmin } = useAuth();

  const isActive = (href: string) =>
    href === "/" ? location === "/" || location === "" : location.startsWith(href);

  const visibleLeftItems = LEFT_NAV_ITEMS.filter(item => !item.adminOnly || isAdmin);

  return (
    <header className="fixed inset-x-0 top-0 h-14 bg-gradient-to-b from-[#232427] to-[#0a0a0b] border-b border-black/60 shadow-[0_1px_0_0_rgba(255,255,255,0.05)_inset] flex items-center px-4 gap-1 z-50">
      <Link href="/feed">
        <div
          className="w-8 h-8 rounded-md bg-white/10 border border-white/20 flex items-center justify-center shrink-0 cursor-pointer mr-3"
          title="Feed"
          onMouseEnter={() => prefetchRouteChunk("feed")}
        >
          <BarChart2 className="w-4 h-4" style={{ color: "#f59e0b", filter: "drop-shadow(0 0 4px #f59e0b80)" }} />
        </div>
      </Link>

      <nav className="flex items-center gap-1">
        {visibleLeftItems.map(item => (
          <NavLink key={item.id} item={item} active={isActive(item.href)} />
        ))}
      </nav>

      <div className="flex-1 flex justify-center">
        <FindUserSearch />
      </div>

      <nav className="flex items-center gap-1">
        {RIGHT_NAV_ITEMS.map(item => (
          <NavLink key={item.id} item={item} active={isActive(item.href)} />
        ))}
      </nav>
    </header>
  );
}
