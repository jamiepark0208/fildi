import { Fragment, useState, useEffect, type FormEvent } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { TopNav } from "@/components/top-nav";
import { useAuth } from "@/context/AuthContext";
import { useSessionState } from "@/hooks/use-session-state";
import { cn } from "@/lib/utils";
import { Copy, Check, Plus, RefreshCw, Trash2, ChevronRight, ChevronDown, Users, Shield, UserPlus } from "lucide-react";
import { StockDBTab } from "@/components/settings/StockDBTab";
import { ApiMonitorTab } from "@/components/settings/ApiMonitorTab";
import { ScheduledTasksTab } from "@/components/settings/ScheduledTasksTab";
import { ResearchTab } from "@/components/settings/ResearchTab";
import { ScorecardGuideContent } from "@/pages/scorecard-explanation";

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

interface FeedbackRow {
  id: number;
  message: string;
  page: string | null;
  createdAt: string;
  username: string;
}

interface CacheEntry { key: string; expiresAt: number; expiresInSec: number; label?: string; stale?: boolean }
interface CacheRow {
  name: string; displayName?: string; ttlMs: number; entryCount: number;
  hits: number | null; misses: number | null; hitRate: string;
  entries: CacheEntry[];
}
interface CacheStatus { caches: CacheRow[]; generatedAt: number }

// ─── User Mgmt Tab ────────────────────────────────────────────────────────────

function UserMgmtTab() {
  const queryClient = useQueryClient();
  const [latestCode, setLatestCode] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<"member" | "admin">("member");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [resetResult, setResetResult] = useState<{ username: string; tempPassword: string } | null>(null);
  const [resettingId, setResettingId] = useState<number | null>(null);

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

  async function createUser(e: FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: newEmail, username: newUsername, password: newPassword, role: newRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to create user");
      setNewEmail("");
      setNewUsername("");
      setNewPassword("");
      setNewRole("member");
      setShowCreateForm(false);
      queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Failed to create user");
    } finally {
      setCreating(false);
    }
  }

  async function resetPassword(id: number, username: string) {
    if (!confirm(`Reset password for ${username}? They'll need the new temporary password to log in.`)) return;
    setResettingId(id);
    try {
      const res = await fetch(`/api/admin/users/${id}/reset-password`, { method: "POST", credentials: "include" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to reset password");
      setResetResult({ username, tempPassword: data.tempPassword });
    } finally {
      setResettingId(null);
    }
  }

  const pendingCount = invites.filter(i => !i.usedBy).length;

  return (
    <div className="space-y-2 max-w-2xl">
      {/* Users card */}
      <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3">
        <div className="flex items-center gap-2 mb-2">
          <Users className="w-3.5 h-3.5 text-[#d4af37]/70" />
          <h2 className="text-xs font-semibold text-white uppercase tracking-wide">Users</h2>
          <span className="text-[10px] text-white">{users.length} total</span>
          <button
            onClick={() => { setShowCreateForm(v => !v); setCreateError(null); }}
            className="ml-auto flex items-center gap-1.5 text-xs font-semibold bg-[#d4af37] text-black px-3 py-1.5 rounded-md hover:bg-[#e0bd4a] transition-colors"
          >
            <UserPlus className="w-3 h-3" />
            {showCreateForm ? "Cancel" : "Create User"}
          </button>
        </div>

        {showCreateForm && (
          <form onSubmit={createUser} className="mb-2 p-2 bg-zinc-900 border border-[#d4af37]/20 rounded-md space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <input
                type="email"
                placeholder="Email"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                required
                className="text-xs bg-zinc-950 border border-[#d4af37]/20 rounded-md px-3 py-1.5 text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50"
              />
              <input
                type="text"
                placeholder="Username"
                value={newUsername}
                onChange={e => setNewUsername(e.target.value)}
                minLength={3}
                maxLength={20}
                required
                className="text-xs bg-zinc-950 border border-[#d4af37]/20 rounded-md px-3 py-1.5 text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50"
              />
              <input
                type="text"
                placeholder="Password (min 8 characters)"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                minLength={8}
                required
                className="text-xs bg-zinc-950 border border-[#d4af37]/20 rounded-md px-3 py-1.5 text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50"
              />
              <select
                value={newRole}
                onChange={e => setNewRole(e.target.value as "member" | "admin")}
                className="text-xs bg-zinc-950 border border-[#d4af37]/20 rounded-md px-3 py-1.5 text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50"
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </div>
            {createError && <p className="text-xs text-red-400">{createError}</p>}
            <button
              type="submit"
              disabled={creating}
              className="text-xs font-semibold bg-[#d4af37] text-black px-3 py-1.5 rounded-md hover:bg-[#e0bd4a] transition-colors disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create Account"}
            </button>
          </form>
        )}

        {resetResult && (
          <div className="mb-2 p-2 bg-green-500/10 border border-green-500/30 rounded-md flex items-center gap-2 text-xs">
            <span className="text-white/70">
              New temp password for <span className="font-semibold text-white">{resetResult.username}</span>:
            </span>
            <code className="font-mono font-bold bg-zinc-900 px-2 py-0.5 rounded text-white">{resetResult.tempPassword}</code>
            <button
              onClick={() => setResetResult(null)}
              className="ml-auto text-white/70 hover:text-white"
            >
              Dismiss
            </button>
          </div>
        )}

        {usersLoading ? (
          <p className="text-xs text-white/70 animate-pulse">Loading…</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/25">
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Username</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Email</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Role</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Joined</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Last Login</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {users.map(u => (
                <tr key={u.id} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-medium text-white">{u.username}</td>
                  <td className="px-2.5 py-1 text-white/70 font-mono text-[10px]">{u.email}</td>
                  <td className="px-2.5 py-1">
                    <span className={cn(
                      "text-[10px] font-semibold px-1.5 py-0.5 rounded border",
                      u.role === "admin"
                        ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
                        : "bg-zinc-900 text-white/70 border-[#d4af37]/20"
                    )}>
                      {u.role}
                    </span>
                  </td>
                  <td className="px-2.5 py-1 text-right text-white/70 tabular-nums">
                    {new Date(u.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-2.5 py-1 text-right tabular-nums">
                    {u.lastLoginAt
                      ? <span className="text-white/70 text-[10px]">{new Date(u.lastLoginAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
                      : <span className="text-white/50 italic">never</span>}
                  </td>
                  <td className="px-2.5 py-1 text-right">
                    <button
                      onClick={() => resetPassword(u.id, u.username)}
                      disabled={resettingId === u.id}
                      className="text-[10px] text-white/70 hover:text-[#d4af37] transition-colors disabled:opacity-50"
                    >
                      {resettingId === u.id ? "Resetting…" : "Reset Password"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Invite Codes card */}
      <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3">
        <div className="flex items-center gap-2 mb-2">
          <Shield className="w-3.5 h-3.5 text-[#d4af37]/70" />
          <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Invite Codes</h2>
          {pendingCount > 0 && (
            <span className="ml-auto text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-green-500/15 text-green-400 border-green-500/30">
              {pendingCount} pending
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mb-2">
          <button
            onClick={generateCode}
            disabled={generating}
            className="flex items-center gap-2 text-xs font-semibold bg-[#d4af37] text-black px-2.5 py-1 rounded-md hover:bg-[#e0bd4a] transition-colors disabled:opacity-50"
          >
            <Plus className="w-3 h-3" />
            {generating ? "Generating…" : "Generate Code"}
          </button>
          {latestCode && (
            <>
              <input
                readOnly
                value={latestCode}
                className="font-mono text-sm bg-zinc-900 border border-[#d4af37]/20 rounded-md px-2.5 py-1 w-32 text-white focus:outline-none"
              />
              <button
                onClick={copyCode}
                className="flex items-center gap-1.5 text-xs text-white/70 hover:text-white border border-[#d4af37]/20 rounded-md px-2.5 py-1.5 transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
                {copied ? "Copied!" : "Copy"}
              </button>
            </>
          )}
        </div>

        {invitesLoading ? (
          <p className="text-xs text-white/70 animate-pulse">Loading codes…</p>
        ) : invites.length === 0 ? (
          <p className="text-xs text-white/70">No invite codes yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/25">
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Code</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Created</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Status</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Used By</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {invites.map(inv => (
                <tr key={inv.code} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-mono font-bold text-white">{inv.code}</td>
                  <td className="px-2.5 py-1 text-white/70">{new Date(inv.createdAt).toLocaleDateString()}</td>
                  <td className="px-2.5 py-1">
                    {inv.usedBy ? (
                      <span className="text-white/70 text-[10px]">Used</span>
                    ) : (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-green-500/15 text-green-400 border-green-500/30">
                        Pending
                      </span>
                    )}
                  </td>
                  <td className="px-2.5 py-1 text-white/70 font-mono text-[10px]">{inv.usedByEmail ?? "—"}</td>
                  <td className="px-2.5 py-1 text-right">
                    <button
                      onClick={() => deleteCode(inv.code)}
                      className="text-[10px] text-white/70 hover:text-red-400 transition-colors"
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

// ─── Feedback Tab ─────────────────────────────────────────────────────────────

function FeedbackTab() {
  const { data: entries = [], isLoading } = useQuery<FeedbackRow[]>({
    queryKey: ["admin", "feedback"],
    queryFn: async () => {
      const res = await fetch("/api/admin/feedback", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load feedback");
      return res.json();
    },
    staleTime: 0,
  });

  return (
    <div className="space-y-3 max-w-3xl">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold text-white uppercase tracking-wide">User Feedback</h2>
          <p className="text-[10px] text-white mt-0.5">{entries.length} total</p>
        </div>
      </div>
      {isLoading ? (
        <p className="text-xs text-white animate-pulse">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-white">No feedback submitted yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[#d4af37]/25">
          <table className="w-full text-xs">
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/25">
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1 w-28">User</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1 w-36">When</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1 w-28">Page</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {entries.map(e => (
                <tr key={e.id} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors align-top">
                  <td className="px-2.5 py-1 font-semibold text-white">{e.username}</td>
                  <td className="px-2.5 py-1 text-white tabular-nums whitespace-nowrap">
                    {new Date(e.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                  </td>
                  <td className="px-2.5 py-1 text-white">{e.page ?? "—"}</td>
                  <td className="px-2.5 py-1 text-white whitespace-pre-wrap">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
    if (rate === "—") return "text-white/70";
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
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 max-w-3xl">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-white uppercase tracking-wide">Cache Monitor</h2>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-xs text-white hover:text-white border border-[#d4af37]/20 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      {isLoading ? (
        <p className="text-xs text-white/70 animate-pulse">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[#d4af37]/25">
          <table className="w-full text-sm">
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/25">
                <th className="w-5 py-1.5" />
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Data Type</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">TTL</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Hits</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Misses</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Hit Rate</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Cached</th>
                <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-3 py-1.5">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {data?.caches.map(row => {
                const isExpanded = expandedRows.has(row.name);
                const displayName = row.displayName ?? row.name;
                return (
                  <Fragment key={row.name}>
                    <tr
                      onClick={() => toggleRow(row.name)}
                      className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 cursor-pointer transition-colors"
                    >
                      <td className="pl-2 pr-1 py-1.5">
                        {isExpanded
                          ? <ChevronDown className="w-3 h-3 text-white/70" />
                          : <ChevronRight className="w-3 h-3 text-white/70" />}
                      </td>
                      <td className="px-3 py-1.5 font-medium text-white">{displayName}</td>
                      <td className="px-3 py-1.5 text-white/70" onClick={e => e.stopPropagation()}>
                        {TTL_EDITABLE_CACHES.has(row.name) ? (
                          <select
                            value={TTL_OPTIONS.some(o => o.ms === row.ttlMs) ? row.ttlMs : ""}
                            onChange={e => ttlMutation.mutate({ name: row.name, ttlMs: Number(e.target.value) })}
                            disabled={ttlMutation.isPending}
                            className="bg-transparent border border-[#d4af37]/20 rounded px-1 py-0.5 text-xs text-white cursor-pointer hover:border-[#d4af37]/50 focus:outline-none disabled:opacity-50"
                          >
                            {!TTL_OPTIONS.some(o => o.ms === row.ttlMs) && (
                              <option value="" className="bg-zinc-950">{fmtTtlHuman(row.ttlMs)}</option>
                            )}
                            {TTL_OPTIONS.map(opt => (
                              <option key={opt.ms} value={opt.ms} className="bg-zinc-950">{opt.label}</option>
                            ))}
                          </select>
                        ) : (
                          fmtTtlHuman(row.ttlMs)
                        )}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-white/70">{row.hits ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-white/70">{row.misses ?? "—"}</td>
                      <td className={cn("px-3 py-1.5 text-right tabular-nums font-semibold", hitRateColor(row.hitRate))}>{row.hitRate}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-white/70">
                        {row.entryCount === 0 ? "—" : `${row.entryCount}`}
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        {row.name !== "volatility-regime" && (
                          <button
                            onClick={e => handleClear(e, row.name)}
                            disabled={clearMutation.isPending}
                            className="flex items-center gap-1 ml-auto text-[10px] text-white/70 hover:text-red-400 transition-colors disabled:opacity-50"
                          >
                            <Trash2 className="w-3 h-3" />
                            Clear
                          </button>
                        )}
                      </td>
                    </tr>
                    {isExpanded && (
                      row.entries.length === 0 ? (
                        <tr key={`${row.name}-empty`} className="bg-zinc-900/40">
                          <td />
                          <td colSpan={7} className="py-1.5 pl-3 text-[10px] text-white/70 italic">No data cached yet</td>
                        </tr>
                      ) : (
                        row.entries.map(entry => {
                          const ageMs = Math.max(0, row.ttlMs - entry.expiresInSec * 1000);
                          const expiresMs = entry.expiresInSec * 1000;
                          const isExpiringSoon = entry.expiresInSec < 300;
                          return (
                            <tr key={`${row.name}-${entry.key}`} className="bg-zinc-900/40">
                              <td />
                              <td colSpan={2} className="py-1 pl-3 font-mono text-[10px] text-white/70 uppercase tracking-wide">
                                {entry.key}
                                {entry.label && (
                                  <span className={cn("ml-2 normal-case font-sans", entry.stale ? "text-red-400 font-semibold" : "text-white/70")}>
                                    {entry.label}
                                  </span>
                                )}
                              </td>
                              <td colSpan={2} className="py-1 text-[10px] text-white/70">
                                {entry.stale ? "no data" : `${formatDuration(ageMs)} ago`}
                              </td>
                              <td colSpan={3} className={cn(
                                "py-1 pr-3 text-right text-[10px] tabular-nums",
                                entry.stale || isExpiringSoon ? "text-red-400 font-semibold" : "text-white/70"
                              )}>
                                {entry.stale ? "SOURCE DEAD" : `expires in ${formatDuration(expiresMs)}`}
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
        </div>
      )}
      {data && (
        <p className="text-[10px] text-white/70 mt-2">
          Generated at {new Date(data.generatedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}

// ─── Inbox (Feedback + Research) ──────────────────────────────────────────────

function InboxTab() {
  const [sub, setSub] = useSessionState<"feedback" | "research">("fildi_settings_inbox", "feedback");
  return (
    <div className="space-y-3">
      <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
        {([
          { id: "feedback" as const, label: "Feedback" },
          { id: "research" as const, label: "Research" },
        ]).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSub(t.id)}
            className={cn(
              "px-2.5 py-1.5 transition-colors",
              sub === t.id ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/70 hover:text-[#d4af37]",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {sub === "feedback" ? <FeedbackTab /> : <ResearchTab />}
    </div>
  );
}

// ─── Settings Page ────────────────────────────────────────────────────────────

type Tab = "users" | "cache" | "stockdb" | "api-monitor" | "scorecard-guide" | "inbox" | "scheduled-tasks";

const LEGACY_TAB: Record<string, Tab> = {
  "data-sources": "api-monitor",
  "peer-groups": "stockdb",
  feedback: "inbox",
  research: "inbox",
  profile: "scorecard-guide",
  agents: "scorecard-guide",
};

export default function Settings() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useSessionState<Tab>("fildi_settings_tab", "scorecard-guide");

  const tabs: { id: Tab; label: string; adminOnly?: boolean }[] = [
    { id: "scorecard-guide", label: "Scorecard Guide" },
    { id: "stockdb",         label: "Stock DB" },
    { id: "api-monitor",     label: "API",             adminOnly: true },
    { id: "users",           label: "Users",           adminOnly: true },
    { id: "cache",           label: "Cache",           adminOnly: true },
    { id: "scheduled-tasks", label: "Tasks",           adminOnly: true },
    { id: "inbox",           label: "Inbox",           adminOnly: true },
  ];

  // Persisted / removed tabs → current homes.
  useEffect(() => {
    const legacy = tab as string;
    if (LEGACY_TAB[legacy]) {
      setTab(LEGACY_TAB[legacy]);
      return;
    }
    if (!tabs.some((t) => t.id === tab)) {
      setTab("scorecard-guide");
      return;
    }
    const current = tabs.find(t => t.id === tab);
    if (current?.adminOnly && !isAdmin) setTab("scorecard-guide");
  }, [isAdmin, tab, setTab]);

  // Ops Nucleus deep-links (API / Stock DB) from Tasks.
  useEffect(() => {
    const onTab = (e: Event) => {
      const next = (e as CustomEvent<string>).detail;
      if (next === "api-monitor" || next === "stockdb" || next === "scheduled-tasks") {
        setTab(next as Tab);
      }
      if (next === "data-sources") setTab("api-monitor");
      if (next === "peer-groups") setTab("stockdb");
    };
    window.addEventListener("fildi:settings-tab", onTab);
    return () => window.removeEventListener("fildi:settings-tab", onTab);
  }, [setTab]);

  const visibleTabs = tabs.filter(t => !t.adminOnly || isAdmin);

  return (
    <div className="min-h-[100dvh] bg-zinc-900">
      <TopNav />
      {/* Custom chrome (sticky header + tabs outside scroll). Same contract as AppPage:
          viewport lock + data-lenis-prevent on the scroll pane — do not use bare pt-14. */}
      <main className="flex flex-col mt-14 h-[calc(100dvh-3.5rem)] min-h-0 overflow-hidden">
        {/* No page title — TopNav gear already says Settings */}
        <div className="shrink-0 border-b border-[#d4af37]/20 bg-zinc-950 px-4 py-1.5">
          <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden text-[11px] font-semibold">
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "px-2.5 py-1.5 transition-colors",
                  tab === t.id ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/70 hover:text-[#d4af37]",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-2" data-lenis-prevent>
          {tab === "scorecard-guide" && <ScorecardGuideContent showHeader={false} />}
          {tab === "users" && isAdmin && <UserMgmtTab />}
          {tab === "cache" && isAdmin && <CacheMonitorTab />}
          {tab === "scheduled-tasks" && isAdmin && <ScheduledTasksTab />}
          {tab === "stockdb" && <StockDBTab />}
          {tab === "api-monitor" && isAdmin && <ApiMonitorTab />}
          {tab === "inbox" && isAdmin && <InboxTab />}
        </div>
      </main>
    </div>
  );
}
