import { Fragment, useState } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Sidebar } from "@/components/sidebar";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";
import { Copy, Check, Plus, RefreshCw, Trash2, ChevronRight, ChevronDown, Users, Shield } from "lucide-react";
import { StockDBTab } from "@/components/settings/StockDBTab";

// ─── Types ────────────────────────────────────────────────────────────────────

interface InviteCode {
  code: string;
  createdBy: number;
  usedBy: number | null;
  usedByEmail: string | null;
  createdAt: string;
  usedAt: string | null;
}

interface AdminUser {
  id: number;
  email: string;
  username: string;
  role: string;
  createdAt: string;
  lastLoginAt: string | null;
}

interface CacheEntry { key: string; expiresAt: number; expiresInSec: number }
interface CacheRow {
  name: string; displayName?: string; ttlMs: number; entryCount: number;
  hits: number | null; misses: number | null; hitRate: string;
  entries: CacheEntry[];
}
interface CacheStatus { caches: CacheRow[]; generatedAt: number }

// ─── Profile Tab ──────────────────────────────────────────────────────────────

function ProfileTab() {
  const { user } = useAuth();
  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm max-w-lg">
      <h2 className="text-sm font-semibold mb-4">Account</h2>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Email</span>
          <span className="text-xs font-mono">{user?.email}</span>
        </div>
        <div className="h-px bg-border/40" />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Username</span>
          <span className="text-xs font-mono">{user?.username}</span>
        </div>
        <div className="h-px bg-border/40" />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Role</span>
          <span className={cn(
            "text-xs font-semibold px-2 py-0.5 rounded border",
            user?.role === "admin"
              ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
              : "bg-secondary text-muted-foreground border-border"
          )}>
            {user?.role}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── User Mgmt Tab ────────────────────────────────────────────────────────────

function UserMgmtTab() {
  const queryClient = useQueryClient();
  const [latestCode, setLatestCode] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: users = [], isLoading: usersLoading } = useQuery<AdminUser[]>({
    queryKey: ["admin", "users"],
    queryFn: async () => {
      const res = await fetch("/api/admin/users", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load users");
      return res.json();
    },
    staleTime: 0,
  });

  const { data: invites = [], isLoading: invitesLoading } = useQuery<InviteCode[]>({
    queryKey: ["admin", "invites"],
    queryFn: async () => {
      const res = await fetch("/api/admin/invites", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load invite codes");
      return res.json();
    },
    staleTime: 0,
  });

  async function generateCode() {
    setGenerating(true);
    try {
      const res = await fetch("/api/admin/invite", { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to generate code");
      setLatestCode(data.code);
      queryClient.invalidateQueries({ queryKey: ["admin", "invites"] });
    } finally {
      setGenerating(false);
    }
  }

  async function copyCode() {
    if (!latestCode) return;
    await navigator.clipboard.writeText(latestCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function deleteCode(code: string) {
    if (!confirm(`Delete invite code ${code}?`)) return;
    await fetch(`/api/admin/invite/${code}`, { method: "DELETE", credentials: "include" });
    queryClient.invalidateQueries({ queryKey: ["admin", "invites"] });
  }

  const pendingCount = invites.filter(i => !i.usedBy).length;

  return (
    <div className="space-y-5 max-w-2xl">
      {/* Users card */}
      <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Users className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Users</h2>
          <span className="ml-auto text-[10px] text-muted-foreground">{users.length} total</span>
        </div>
        {usersLoading ? (
          <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border">
                <th className="text-left py-2 font-semibold">Username</th>
                <th className="text-left py-2 font-semibold">Email</th>
                <th className="text-left py-2 font-semibold">Role</th>
                <th className="text-right py-2 font-semibold">Joined</th>
                <th className="text-right py-2 font-semibold">Last Login</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {users.map(u => (
                <tr key={u.id} className="h-9">
                  <td className="font-medium text-foreground">{u.username}</td>
                  <td className="text-muted-foreground font-mono text-[10px]">{u.email}</td>
                  <td>
                    <span className={cn(
                      "text-[10px] font-semibold px-1.5 py-0.5 rounded border",
                      u.role === "admin"
                        ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
                        : "bg-secondary text-muted-foreground border-border"
                    )}>
                      {u.role}
                    </span>
                  </td>
                  <td className="text-right text-muted-foreground tabular-nums">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="text-right tabular-nums">
                    {u.lastLoginAt
                      ? <span className="text-foreground/70">{new Date(u.lastLoginAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
                      : <span className="text-muted-foreground/50 italic">never</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Invite Codes card */}
      <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Shield className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Invite Codes</h2>
          {pendingCount > 0 && (
            <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-green-500/15 text-green-400 border-green-500/30">
              {pendingCount} pending
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={generateCode}
            disabled={generating}
            className="flex items-center gap-2 text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            <Plus className="w-3 h-3" />
            {generating ? "Generating…" : "Generate Code"}
          </button>
          {latestCode && (
            <>
              <input
                readOnly
                value={latestCode}
                className="font-mono text-sm bg-secondary border border-border rounded-md px-3 py-1.5 w-32 text-foreground focus:outline-none"
              />
              <button
                onClick={copyCode}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2.5 py-1.5 transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                {copied ? "Copied!" : "Copy"}
              </button>
            </>
          )}
        </div>

        {invitesLoading ? (
          <p className="text-xs text-muted-foreground animate-pulse">Loading codes…</p>
        ) : invites.length === 0 ? (
          <p className="text-xs text-muted-foreground">No invite codes yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border">
                <th className="text-left py-2 font-semibold">Code</th>
                <th className="text-left py-2 font-semibold">Created</th>
                <th className="text-left py-2 font-semibold">Status</th>
                <th className="text-left py-2 font-semibold">Used By</th>
                <th className="text-right py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/40">
              {invites.map(inv => (
                <tr key={inv.code} className="h-8">
                  <td className="font-mono font-bold">{inv.code}</td>
                  <td className="text-muted-foreground">{new Date(inv.createdAt).toLocaleDateString()}</td>
                  <td>
                    {inv.usedBy ? (
                      <span className="text-muted-foreground text-[10px]">Used</span>
                    ) : (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-green-500/15 text-green-400 border-green-500/30">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="text-muted-foreground font-mono text-[10px]">{inv.usedByEmail ?? "—"}</td>
                  <td className="text-right">
                    <button
                      onClick={() => deleteCode(inv.code)}
                      className="text-[10px] text-muted-foreground hover:text-red-400 transition-colors"
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Cache Monitor Tab ────────────────────────────────────────────────────────

const TTL_OPTIONS = [
  { ms: 5 * 60_000,    label: "5 min" },
  { ms: 15 * 60_000,   label: "15 min" },
  { ms: 30 * 60_000,   label: "30 min" },
  { ms: 60 * 60_000,   label: "1 hour" },
  { ms: 240 * 60_000,  label: "4 hours" },
  { ms: 720 * 60_000,  label: "12 hours" },
  { ms: 1440 * 60_000, label: "24 hours" },
];

const TTL_EDITABLE_CACHES = new Set([
  "search", "compare", "history", "history-1d", "quote",
  "breakdown", "options", "options-expiry", "peer-map",
]);

function CacheMonitorTab() {
  const queryClient = useQueryClient();
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const { data, isLoading, refetch, isFetching } = useQuery<CacheStatus>({
    queryKey: ["admin", "cache-status"],
    queryFn: async () => {
      const res = await fetch("/api/admin/cache/status", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load cache status");
      return res.json();
    },
    staleTime: 0,
  });

  const ttlMutation = useMutation({
    mutationFn: async ({ name, ttlMs }: { name: string; ttlMs: number }) => {
      const res = await fetch(`/api/admin/cache/ttl/${name}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ttlMs }),
      });
      if (!res.ok) throw new Error("Failed to update TTL");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "cache-status"] }),
  });

  const clearMutation = useMutation({
    mutationFn: async (name: string) => {
      const res = await fetch(`/api/admin/cache/clear/${name}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error("Failed to clear cache");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["admin", "cache-status"] }),
  });

  function toggleRow(name: string) {
    setExpandedRows(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  function handleClear(e: React.MouseEvent, name: string) {
    e.stopPropagation();
    if (!confirm(`Clear "${name}" cache? Next requests will re-fetch from the source.`)) return;
    clearMutation.mutate(name);
  }

  function hitRateColor(rate: string) {
    if (rate === "—") return "text-muted-foreground";
    const n = parseInt(rate);
    if (n >= 70) return "text-green-400";
    if (n >= 40) return "text-yellow-400";
    return "text-red-400";
  }

  function fmtTtlHuman(ms: number) {
    const hours = ms / 3600000;
    const mins = ms / 60000;
    if (Number.isInteger(hours)) return hours === 1 ? "1 hour" : `${hours} hours`;
    if (Number.isInteger(mins)) return `${mins} min`;
    return `${Math.round(hours * 10) / 10} hr`;
  }

  function formatDuration(ms: number): string {
    const totalSec = Math.floor(Math.abs(ms) / 1000);
    if (totalSec < 60) return `${totalSec}s`;
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const remMins = mins % 60;
    return remMins > 0 ? `${hrs} hr ${remMins} min` : `${hrs} hr`;
  }

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold">Cache Monitor</h2>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border">
                <th className="w-5 py-2" />
                <th className="text-left py-2 font-semibold">Data Type</th>
                <th className="text-left py-2 font-semibold">TTL</th>
                <th className="text-right py-2 font-semibold">Hits</th>
                <th className="text-right py-2 font-semibold">Misses</th>
                <th className="text-right py-2 font-semibold">Hit Rate</th>
                <th className="text-right py-2 font-semibold">Cached</th>
                <th className="text-right py-2 font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data?.caches.map(row => {
                const isExpanded = expandedRows.has(row.name);
                const displayName = row.displayName ?? row.name;
                return (
                  <Fragment key={row.name}>
                    <tr
                      onClick={() => toggleRow(row.name)}
                      className="h-9 border-b border-border/40 cursor-pointer hover:bg-muted/20 transition-colors"
                    >
                      <td className="pl-1 pr-2">
                        {isExpanded
                          ? <ChevronDown className="w-3 h-3 text-muted-foreground" />
                          : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                      </td>
                      <td className="font-medium text-foreground">{displayName}</td>
                      <td className="text-muted-foreground" onClick={e => e.stopPropagation()}>
                        {TTL_EDITABLE_CACHES.has(row.name) ? (
                          <select
                            value={TTL_OPTIONS.some(o => o.ms === row.ttlMs) ? row.ttlMs : ""}
                            onChange={e => ttlMutation.mutate({ name: row.name, ttlMs: Number(e.target.value) })}
                            disabled={ttlMutation.isPending}
                            className="bg-transparent border border-border rounded px-1 py-0.5 text-xs text-foreground cursor-pointer hover:border-muted-foreground focus:outline-none disabled:opacity-50"
                          >
                            {!TTL_OPTIONS.some(o => o.ms === row.ttlMs) && (
                              <option value="" className="bg-background">{fmtTtlHuman(row.ttlMs)}</option>
                            )}
                            {TTL_OPTIONS.map(opt => (
                              <option key={opt.ms} value={opt.ms} className="bg-background">{opt.label}</option>
                            ))}
                          </select>
                        ) : (
                          fmtTtlHuman(row.ttlMs)
                        )}
                      </td>
                      <td className="text-right tabular-nums text-muted-foreground">{row.hits ?? "—"}</td>
                      <td className="text-right tabular-nums text-muted-foreground">{row.misses ?? "—"}</td>
                      <td className={cn("text-right tabular-nums font-semibold", hitRateColor(row.hitRate))}>{row.hitRate}</td>
                      <td className="text-right tabular-nums text-muted-foreground">
                        {row.entryCount === 0 ? "—" : `${row.entryCount}`}
                      </td>
                      <td className="text-right">
                        {row.name !== "macro-regime" && (
                          <button
                            onClick={e => handleClear(e, row.name)}
                            disabled={clearMutation.isPending}
                            className="flex items-center gap-1 ml-auto text-[10px] text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-50"
                          >
                            <Trash2 className="w-3 h-3" />
                            Clear
                          </button>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      row.entries.length === 0 ? (
                        <tr key={`${row.name}-empty`} className="bg-muted/10 border-b border-border/20">
                          <td />
                          <td colSpan={7} className="py-2 pl-3 text-[10px] text-muted-foreground italic">No data cached yet</td>
                        </tr>
                      ) : (
                        row.entries.map(entry => {
                          const ageMs = Math.max(0, row.ttlMs - entry.expiresInSec * 1000);
                          const expiresMs = entry.expiresInSec * 1000;
                          const isExpiringSoon = entry.expiresInSec < 300;
                          return (
                            <tr key={`${row.name}-${entry.key}`} className="bg-muted/10 border-b border-border/20">
                              <td />
                              <td colSpan={2} className="py-1.5 pl-3 font-mono text-[10px] text-foreground/70 uppercase tracking-wide">{entry.key}</td>
                              <td colSpan={2} className="py-1.5 text-[10px] text-muted-foreground">{formatDuration(ageMs)} ago</td>
                              <td colSpan={3} className={cn(
                                "py-1.5 pr-1 text-right text-[10px] tabular-nums",
                                isExpiringSoon ? "text-red-400 font-semibold" : "text-muted-foreground"
                              )}>
                                expires in {formatDuration(expiresMs)}
                              </td>
                            </tr>
                          );
                        })
                      )
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {data && (
            <p className="text-[10px] text-muted-foreground mt-3">
              Generated at {new Date(data.generatedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Settings Page ────────────────────────────────────────────────────────────

type Tab = "profile" | "users" | "cache" | "stockdb";

export default function Settings() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>("profile");

  const tabs: { id: Tab; label: string; adminOnly?: boolean }[] = [
    { id: "profile", label: "Profile" },
    { id: "users",   label: "User Mgmt",     adminOnly: true },
    { id: "cache",   label: "Cache Monitor",  adminOnly: true },
    { id: "stockdb", label: "Stock DB",       adminOnly: true },
  ];

  const visibleTabs = tabs.filter(t => !t.adminOnly || isAdmin);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex">
      <Sidebar />
      <main
        className="flex-1 flex flex-col overflow-hidden"
        style={{ marginLeft: "var(--sidebar-w, 220px)", transition: "margin-left 200ms ease" }}
      >
        {/* Header */}
        <div className="shrink-0 border-b border-border bg-background px-6 py-4">
          <h1 className="text-lg font-bold tracking-tight leading-none">Settings</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Account and administration</p>
        </div>

        {/* Sub-tabs */}
        <div className="shrink-0 flex gap-1 border-b border-border px-6 bg-background">
          {visibleTabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "text-xs font-medium px-3 py-2.5 border-b-2 transition-colors -mb-px",
                tab === t.id
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === "profile" && <ProfileTab />}
          {tab === "users"   && isAdmin && <UserMgmtTab />}
          {tab === "cache"   && isAdmin && <CacheMonitorTab />}
          {tab === "stockdb" && isAdmin && <StockDBTab />}
        </div>
      </main>
    </div>
  );
}
