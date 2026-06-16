import { useState, useEffect, useCallback } from "react";
import {
  BarChart2, LineChart, BarChart, Bookmark,
  Settings as SettingsIcon, BriefcaseBusiness, BookOpen,
  ScanLine, Globe, LogOut, ChevronLeft, ChevronRight, GripVertical,
} from "lucide-react";
import { Link, useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useAuth } from "@/context/AuthContext";

const COLLAPSED_KEY = "fildi_sidebar_collapsed";
const ORDER_KEY = "fildi_sidebar_order";
const EXPANDED_W = 220;
const COLLAPSED_W = 56;

type NavItem = {
  id: string;
  href: string;
  label: string;
  icon: keyof typeof ICONS;
  adminOnly?: boolean;
};

type NavGroup = {
  id: string;
  label: string;
  items: NavItem[];
};

const ICONS = {
  BarChart,
  BarChart2,
  LineChart,
  Bookmark,
  Settings: SettingsIcon,
  BriefcaseBusiness,
  BookOpen,
  ScanLine,
  Globe,
} as const;

const DEFAULT_GROUPS: NavGroup[] = [
  {
    id: "main",
    label: "Main",
    items: [
      { id: "watchlist", href: "/watchlist", label: "Watchlist", icon: "Bookmark" },
      { id: "portfolio", href: "/portfolio", label: "Portfolio", icon: "BriefcaseBusiness", adminOnly: true },
    ],
  },
  {
    id: "analysis",
    label: "Analysis",
    items: [
      { id: "fundamental", href: "/", label: "Fundamental", icon: "BarChart" },
      { id: "technical", href: "/technical", label: "Technical", icon: "LineChart" },
      { id: "options-scanner", href: "/options-scanner", label: "Options Scanner", icon: "ScanLine" },
      { id: "macro", href: "/macro", label: "Macro", icon: "Globe" },
    ],
  },
  {
    id: "general",
    label: "General",
    items: [
      { id: "scorecard-guide", href: "/scorecard-explanation", label: "Scorecard Guide", icon: "BookOpen" },
      { id: "settings", href: "/settings", label: "Settings", icon: "Settings" },
    ],
  },
];

function loadGroups(): NavGroup[] {
  try {
    const raw = localStorage.getItem(ORDER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as NavGroup[];
      // Ensure any new items added to DEFAULT_GROUPS are included
      const allItemIds = new Set(parsed.flatMap(g => g.items.map(i => i.id)));
      const defaultItemMap = new Map(DEFAULT_GROUPS.flatMap(g => g.items.map(i => [i.id, i])));
      for (const defaultGroup of DEFAULT_GROUPS) {
        for (const defaultItem of defaultGroup.items) {
          if (!allItemIds.has(defaultItem.id)) {
            const targetGroup = parsed.find(g => g.id === defaultGroup.id) ?? parsed[0];
            targetGroup.items.push(defaultItemMap.get(defaultItem.id)!);
          }
        }
      }
      return parsed;
    }
  } catch {}
  return DEFAULT_GROUPS;
}

function saveGroups(groups: NavGroup[]) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(groups)); } catch {}
}

export function applySidebarWidth(collapsed: boolean) {
  document.documentElement.style.setProperty(
    "--sidebar-w",
    collapsed ? `${COLLAPSED_W}px` : `${EXPANDED_W}px`
  );
}

export function Sidebar() {
  const [location, navigate] = useLocation();
  const { isAdmin, refetch } = useAuth();

  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "true"; } catch { return false; }
  });
  const [groups, setGroups] = useState<NavGroup[]>(loadGroups);

  // drag state: "group:groupId" | "item:groupId:itemId"
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  useEffect(() => {
    applySidebarWidth(collapsed);
    try { localStorage.setItem(COLLAPSED_KEY, String(collapsed)); } catch {}
  }, [collapsed]);

  // Initialize CSS var immediately on mount (before first paint)
  useEffect(() => { applySidebarWidth(collapsed); }, []); // eslint-disable-line

  const updateGroups = useCallback((next: NavGroup[]) => {
    setGroups(next);
    saveGroups(next);
  }, []);

  function handleItemDrop(targetGroupId: string, targetItemId: string) {
    if (!dragKey) return;
    const parts = dragKey.split(":");
    if (parts[0] !== "item") return;
    const [, srcGroupId, srcItemId] = parts;
    if (srcGroupId === targetGroupId && srcItemId === targetItemId) { setDragKey(null); setDropKey(null); return; }

    const next = groups.map(g => ({ ...g, items: [...g.items] }));
    const srcGroup = next.find(g => g.id === srcGroupId)!;
    const tgtGroup = next.find(g => g.id === targetGroupId)!;
    const srcItem = srcGroup.items.find(i => i.id === srcItemId)!;
    srcGroup.items = srcGroup.items.filter(i => i.id !== srcItemId);
    const tgtIdx = tgtGroup.items.findIndex(i => i.id === targetItemId);
    tgtGroup.items.splice(tgtIdx, 0, srcItem);
    updateGroups(next);
    setDragKey(null);
    setDropKey(null);
  }

  function handleItemDropOnGroup(targetGroupId: string) {
    if (!dragKey) return;
    const parts = dragKey.split(":");
    if (parts[0] !== "item") return;
    const [, srcGroupId, srcItemId] = parts;
    if (srcGroupId === targetGroupId) { setDragKey(null); setDropKey(null); return; }

    const next = groups.map(g => ({ ...g, items: [...g.items] }));
    const srcGroup = next.find(g => g.id === srcGroupId)!;
    const tgtGroup = next.find(g => g.id === targetGroupId)!;
    const srcItem = srcGroup.items.find(i => i.id === srcItemId)!;
    srcGroup.items = srcGroup.items.filter(i => i.id !== srcItemId);
    tgtGroup.items.push(srcItem);
    updateGroups(next);
    setDragKey(null);
    setDropKey(null);
  }

  function handleGroupDrop(targetGroupId: string) {
    if (!dragKey) return;
    const parts = dragKey.split(":");
    if (parts[0] !== "group") return;
    const srcGroupId = parts[1];
    if (srcGroupId === targetGroupId) { setDragKey(null); setDropKey(null); return; }

    const srcIdx = groups.findIndex(g => g.id === srcGroupId);
    const tgtIdx = groups.findIndex(g => g.id === targetGroupId);
    const next = [...groups];
    const [moved] = next.splice(srcIdx, 1);
    next.splice(tgtIdx, 0, moved);
    updateGroups(next);
    setDragKey(null);
    setDropKey(null);
  }

  const isActive = (href: string) =>
    href === "/" ? location === "/" || location === "" : location.startsWith(href);

  const isDraggingItem = dragKey?.startsWith("item:");
  const isDraggingGroup = dragKey?.startsWith("group:");

  return (
    <aside
      className={cn(
        "fixed inset-y-0 left-0 bg-sidebar border-r border-sidebar-border overflow-y-auto flex flex-col z-50",
        "transition-[width] duration-200 ease-in-out",
        collapsed ? "w-14" : "w-[220px]"
      )}
    >
      {/* ── Header ── */}
      <div className={cn("p-4 flex items-center", collapsed ? "justify-center" : "justify-between")}>
        <div className={cn("flex items-center gap-3", collapsed && "justify-center")}>
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center shrink-0">
            <BarChart2 className="w-4 h-4 text-primary-foreground" />
          </div>
          {!collapsed && (
            <span className="font-bold tracking-tight text-base text-white">FILDI</span>
          )}
        </div>
        {!collapsed && (
          <button
            onClick={() => setCollapsed(true)}
            className="p-1 rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            title="Collapse sidebar"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {collapsed && (
        <div className="flex justify-center pb-2">
          <button
            onClick={() => setCollapsed(false)}
            className="p-1.5 rounded hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            title="Expand sidebar"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="px-4 mb-2">
        <div className="h-px bg-sidebar-border w-full" />
      </div>

      {/* ── Nav Groups ── */}
      <div className={cn("flex-1 space-y-3 mt-1 pb-6", collapsed ? "px-1" : "px-2")}>
        {groups.map(group => {
          const visibleItems = group.items.filter(item => !item.adminOnly || isAdmin);
          const groupDropKey = `group:${group.id}`;
          const isGroupDropTarget = dropKey === groupDropKey && isDraggingGroup;
          const isGroupItemDropTarget = dropKey === groupDropKey && isDraggingItem;

          return (
            <div
              key={group.id}
              onDragOver={e => { e.preventDefault(); setDropKey(groupDropKey); }}
              onDrop={e => {
                if (isDraggingGroup) { e.preventDefault(); handleGroupDrop(group.id); }
                else if (isDraggingItem) { e.preventDefault(); handleItemDropOnGroup(group.id); }
              }}
              className={cn(
                "rounded-lg transition-colors duration-100",
                isGroupDropTarget && "bg-primary/10 ring-1 ring-primary/30",
                isGroupItemDropTarget && "bg-white/5"
              )}
            >
              {/* Group Label (drag handle for group reordering) */}
              {!collapsed && (
                <div
                  draggable
                  onDragStart={e => {
                    e.dataTransfer.effectAllowed = "move";
                    e.stopPropagation();
                    setDragKey(groupDropKey);
                  }}
                  onDragEnd={() => { setDragKey(null); setDropKey(null); }}
                  className="flex items-center gap-1.5 px-2 py-1 mb-0.5 cursor-grab active:cursor-grabbing group/hdr select-none"
                >
                  <GripVertical className="w-3 h-3 text-white/20 group-hover/hdr:text-white/60 transition-colors shrink-0" />
                  <span className="text-[10px] font-bold text-white/70 uppercase tracking-widest group-hover/hdr:text-white transition-colors">
                    {group.label}
                  </span>
                </div>
              )}

              {/* Nav Items */}
              <nav className="space-y-0.5">
                {visibleItems.map(item => {
                  const Icon = ICONS[item.icon];
                  const active = isActive(item.href);
                  const itemKey = `item:${group.id}:${item.id}`;
                  const isItemDrop = dropKey === itemKey && dragKey && dragKey !== itemKey;

                  return (
                    <div
                      key={item.id}
                      draggable
                      onDragStart={e => {
                        e.dataTransfer.effectAllowed = "move";
                        e.stopPropagation();
                        setDragKey(itemKey);
                      }}
                      onDragEnd={() => { setDragKey(null); setDropKey(null); }}
                      onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropKey(itemKey); }}
                      onDrop={e => { e.stopPropagation(); handleItemDrop(group.id, item.id); }}
                      className={cn(
                        "rounded-md transition-colors duration-100",
                        isItemDrop && "ring-1 ring-primary/60 bg-primary/10"
                      )}
                    >
                      <Link href={item.href}>
                        <div className={cn(
                          "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium cursor-pointer transition-colors",
                          collapsed && "justify-center px-2",
                          active
                            ? "bg-primary/15 text-white"
                            : "text-white/85 hover:text-white hover:bg-white/8"
                        )}>
                          <Icon className={cn("shrink-0", collapsed ? "w-5 h-5" : "w-4 h-4")} />
                          {!collapsed && <span className="leading-none">{item.label}</span>}
                        </div>
                      </Link>
                    </div>
                  );
                })}
              </nav>
            </div>
          );
        })}
      </div>

      {/* ── Logout ── */}
      <div className={cn("pb-4", collapsed ? "px-1" : "px-2")}>
        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
            await refetch();
            navigate("/login");
          }}
          className={cn(
            "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium",
            "text-white/75 hover:text-white hover:bg-white/8 transition-colors",
            collapsed && "justify-center px-2"
          )}
          title={collapsed ? "Log out" : undefined}
        >
          <LogOut className={cn("shrink-0", collapsed ? "w-5 h-5" : "w-4 h-4")} />
          {!collapsed && <span>Log out</span>}
        </button>
      </div>
    </aside>
  );
}
