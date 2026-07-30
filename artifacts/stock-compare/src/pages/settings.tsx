import { Fragment, useState, useEffect, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { TopNav } from "@/components/top-nav";
import { useAuth } from "@/context/AuthContext";
import { useSessionState } from "@/hooks/use-session-state";
import { cn } from "@/lib/utils";
import { Copy, Check, Plus, RefreshCw, Trash2, ChevronRight, ChevronDown, Users, Shield, LogOut, UserPlus, KeyRound } from "lucide-react";
import { TabBar, type TabBarColor } from "@/components/ui/tab-bar";
import { StockDBTab } from "@/components/settings/StockDBTab";
import { ApiMonitorTab } from "@/components/settings/ApiMonitorTab";
import { ScheduledTasksTab } from "@/components/settings/ScheduledTasksTab";
import { ScorecardGuideContent } from "@/pages/scorecard-explanation";
import { getTraderPrefs, saveTraderPrefs, DEFAULT_TRADER_PREFS } from "@/lib/trader-prefs";

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

// ─── Profile Tab ──────────────────────────────────────────────────────────────

function ProfileTab() {
  const { user, refetch } = useAuth();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwSubmitting, setPwSubmitting] = useState(false);

  const handleLogout = async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    queryClient.removeQueries({ queryKey: ["watchlist"] });
    queryClient.removeQueries({ queryKey: ["portfolio-snapshot-latest"] });
    await refetch();
    navigate("/login");
  };

  const handleChangePassword = async (e: FormEvent) => {
    e.preventDefault();
    setPwError(null);
    setPwSuccess(false);
    if (newPassword !== confirmPassword) {
      setPwError("New passwords don't match");
      return;
    }
    setPwSubmitting(true);
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to change password");
      setPwSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setTimeout(() => setPwSuccess(false), 3000);
    } catch (err) {
      setPwError(err instanceof Error ? err.message : "Failed to change password");
    } finally {
      setPwSubmitting(false);
    }
  };

  return (
    <div className="space-y-5 max-w-lg">
      <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
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
          <div className="h-px bg-border/40" />
          <button
            onClick={handleLogout}
            className="flex items-center gap-2 text-xs text-muted-foreground hover:text-red-400 transition-colors pt-1"
          >
            <LogOut className="w-3.5 h-3.5" />
            Log out
          </button>
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <KeyRound className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Change Password</h2>
        </div>
        <form onSubmit={handleChangePassword} className="space-y-3">
          <input
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={e => setCurrentPassword(e.target.value)}
            required
            className="w-full text-xs bg-secondary border border-border rounded-md px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="password"
            placeholder="New password (min 8 characters)"
            value={newPassword}
            onChange={e => setNewPassword(e.target.value)}
            minLength={8}
            required
            className="w-full text-xs bg-secondary border border-border rounded-md px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            minLength={8}
            required
            className="w-full text-xs bg-secondary border border-border rounded-md px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {pwError && <p className="text-xs text-red-400">{pwError}</p>}
          {pwSuccess && <p className="text-xs text-green-400">Password updated.</p>}
          <button
            type="submit"
            disabled={pwSubmitting}
            className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {pwSubmitting ? "Updating…" : "Update Password"}
          </button>
        </form>
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
    <div className="space-y-5 max-w-2xl">
      {/* Users card */}
      <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <Users className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Users</h2>
          <span className="text-[10px] text-muted-foreground">{users.length} total</span>
          <button
            onClick={() => { setShowCreateForm(v => !v); setCreateError(null); }}
            className="ml-auto flex items-center gap-1.5 text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity"
          >
            <UserPlus className="w-3 h-3" />
            {showCreateForm ? "Cancel" : "Create User"}
          </button>
        </div>

        {showCreateForm && (
          <form onSubmit={createUser} className="mb-4 p-4 bg-secondary/50 border border-border rounded-lg space-y-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <input
                type="email"
                placeholder="Email"
                value={newEmail}
                onChange={e => setNewEmail(e.target.value)}
                required
                className="text-xs bg-secondary border border-border rounded-md px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <input
                type="text"
                placeholder="Username"
                value={newUsername}
                onChange={e => setNewUsername(e.target.value)}
                minLength={3}
                maxLength={20}
                required
                className="text-xs bg-secondary border border-border rounded-md px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <input
                type="text"
                placeholder="Password (min 8 characters)"
                value={newPassword}
                onChange={e => setNewPassword(e.target.value)}
                minLength={8}
                required
                className="text-xs bg-secondary border border-border rounded-md px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <select
                value={newRole}
                onChange={e => setNewRole(e.target.value as "member" | "admin")}
                className="text-xs bg-secondary border border-border rounded-md px-3 py-1.5 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              >
                <option value="member">member</option>
                <option value="admin">admin</option>
              </select>
            </div>
            {createError && <p className="text-xs text-red-400">{createError}</p>}
            <button
              type="submit"
              disabled={creating}
              className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
            >
              {creating ? "Creating…" : "Create Account"}
            </button>
          </form>
        )}

        {resetResult && (
          <div className="mb-4 p-3 bg-green-500/10 border border-green-500/30 rounded-lg flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              New temp password for <span className="font-semibold text-foreground">{resetResult.username}</span>:
            </span>
            <code className="font-mono font-bold bg-secondary px-2 py-0.5 rounded">{resetResult.tempPassword}</code>
            <button
              onClick={() => setResetResult(null)}
              className="ml-auto text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        )}

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
                <th className="text-right py-2 font-semibold">Actions</th>
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
                  <td className="text-right">
                    <button
                      onClick={() => resetPassword(u.id, u.username)}
                      disabled={resettingId === u.id}
                      className="text-[10px] text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
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
    <div className="max-w-2xl">
      <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-sm font-semibold">User Feedback</h2>
          <span className="ml-auto text-[10px] text-muted-foreground">{entries.length} total</span>
        </div>
        {isLoading ? (
          <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-xs text-muted-foreground">No feedback submitted yet.</p>
        ) : (
          <div className="divide-y divide-border/40">
            {entries.map(e => (
              <div key={e.id} className="py-3 space-y-1">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span className="font-semibold text-foreground">{e.username}</span>
                  <span>{new Date(e.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}</span>
                  {e.page && <span className="font-mono">{e.page}</span>}
                </div>
                <p className="text-xs whitespace-pre-wrap">{e.message}</p>
              </div>
            ))}
          </div>
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
                        {row.name !== "volatility-regime" && (
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
                              <td colSpan={2} className="py-1.5 pl-3 font-mono text-[10px] text-foreground/70 uppercase tracking-wide">
                                {entry.key}
                                {entry.label && (
                                  <span className={cn("ml-2 normal-case font-sans", entry.stale ? "text-red-400 font-semibold" : "text-muted-foreground")}>
                                    {entry.label}
                                  </span>
                                )}
                              </td>
                              <td colSpan={2} className="py-1.5 text-[10px] text-muted-foreground">
                                {entry.stale ? "no data" : `${formatDuration(ageMs)} ago`}
                              </td>
                              <td colSpan={3} className={cn(
                                "py-1.5 pr-1 text-right text-[10px] tabular-nums",
                                entry.stale || isExpiringSoon ? "text-red-400 font-semibold" : "text-muted-foreground"
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

// ─── Trading Tab ──────────────────────────────────────────────────────────────

interface BriefContextSummary { strategy: string; userNotes: string; lastUpdated: string }

function TradingTab() {
  const { user, isAdmin } = useAuth();
  const [, navigate] = useLocation();
  const [minWeeklyIncome, setMinWeeklyIncome] = useState(() => getTraderPrefs(user?.id).minWeeklyIncome);
  const [input, setInput] = useState(() => String(getTraderPrefs(user?.id).minWeeklyIncome));
  const [saved, setSaved] = useState(false);

  const { data: briefCtx } = useQuery<BriefContextSummary>({
    queryKey: ["daily-brief-context"],
    queryFn: async () => {
      const r = await fetch("/api/daily-brief/context", { credentials: "include" });
      if (!r.ok) throw new Error();
      return r.json();
    },
    staleTime: 60000,
  });

  const handleSave = () => {
    const n = parseFloat(input);
    if (!Number.isFinite(n) || n < 0) return;
    setMinWeeklyIncome(n);
    saveTraderPrefs({ minWeeklyIncome: n }, user?.id);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const handleReset = () => {
    setInput(String(DEFAULT_TRADER_PREFS.minWeeklyIncome));
    setMinWeeklyIncome(DEFAULT_TRADER_PREFS.minWeeklyIncome);
    saveTraderPrefs(DEFAULT_TRADER_PREFS, user?.id);
  };

  return (
    <div className="space-y-5 max-w-lg">
      <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
        <h2 className="text-sm font-semibold mb-1">Scanner Defaults</h2>
        <p className="text-xs text-muted-foreground mb-4">Applied when Options Scanner loads. Stored on this device.</p>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Min weekly income ≥</span>
          <div className="flex items-center gap-1 border border-border rounded-md px-2 h-7">
            <input
              type="number"
              min="0"
              step="0.1"
              value={input}
              onChange={e => setInput(e.target.value)}
              className="w-12 text-xs bg-transparent text-foreground focus:outline-none text-center"
            />
            <span className="text-xs text-muted-foreground">%/wk</span>
          </div>
          <button
            onClick={handleSave}
            className="text-xs font-medium px-3 py-1.5 rounded-lg border border-primary/30 bg-primary/15 text-primary hover:bg-primary/25 transition-colors"
          >
            {saved ? "Saved" : "Save as default"}
          </button>
          {minWeeklyIncome !== DEFAULT_TRADER_PREFS.minWeeklyIncome && (
            <button onClick={handleReset} className="text-xs text-muted-foreground hover:text-foreground transition-colors">
              Reset
            </button>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
        <h2 className="text-sm font-semibold mb-1">Score Weights</h2>
        <p className="text-xs text-muted-foreground mb-3">Fundamental / technical / options weighting used across the app.</p>
        <button
          onClick={() => navigate("/scorecard-explanation")}
          className="text-xs font-medium text-primary hover:underline"
        >
          Edit score weights → Scorecard Guide
        </button>
      </div>

      <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
        <h2 className="text-sm font-semibold mb-1">Daily Brief Context</h2>
        {isAdmin ? (
          <p className="text-xs text-muted-foreground">
            Managed on{" "}
            <button onClick={() => navigate("/portfolio")} className="text-primary hover:underline">
              Portfolio
            </button>
            .
          </p>
        ) : (
          <div className="text-xs text-muted-foreground space-y-1.5">
            <p>Strategy: <span className="text-foreground/80">{briefCtx?.strategy || "—"}</span></p>
            <p>Notes: <span className="text-foreground/80">{briefCtx?.userNotes || "—"}</span></p>
            <p className="text-muted-foreground/60">Read-only — set by an admin.</p>
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-xl p-6 shadow-sm opacity-60">
        <h2 className="text-sm font-semibold mb-1">Alerts</h2>
        <p className="text-xs text-muted-foreground">Coming when background job-queue is approved.</p>
        <div className="flex items-center gap-2 mt-3">
          <input type="checkbox" disabled className="cursor-not-allowed" />
          <span className="text-xs text-muted-foreground">Notify on new scanner strikes matching my filters</span>
        </div>
      </div>
    </div>
  );
}

// ─── Settings Page ────────────────────────────────────────────────────────────

type Tab = "profile" | "trading" | "users" | "cache" | "stockdb" | "api-monitor" | "scorecard-guide" | "feedback" | "scheduled-tasks";

export default function Settings() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useSessionState<Tab>("fildi_settings_tab", "profile");

  const tabs: { id: Tab; label: string; adminOnly?: boolean; color: TabBarColor }[] = [
    { id: "profile",         label: "Profile",         color: "blue" },
    { id: "trading",         label: "Trading",         color: "emerald" },
    { id: "scorecard-guide", label: "Scorecard Guide", color: "violet" },
    { id: "users",           label: "User Mgmt",       color: "amber",   adminOnly: true },
    { id: "cache",           label: "Cache Monitor",   color: "cyan",    adminOnly: true },
    { id: "scheduled-tasks", label: "Scheduled Tasks", color: "rose",    adminOnly: true },
    { id: "stockdb",         label: "Stock DB",        color: "teal" },
    { id: "api-monitor",     label: "API Monitor",     color: "orange",  adminOnly: true },
    { id: "feedback",        label: "Feedback",        color: "fuchsia", adminOnly: true },
  ];

  // Persisted tab may point at an admin-only tab from a prior admin session —
  // fall back to Profile rather than rendering a blank pane.
  useEffect(() => {
    const current = tabs.find(t => t.id === tab);
    if (current?.adminOnly && !isAdmin) setTab("profile");
  }, [isAdmin, tab, setTab]);

  const visibleTabs = tabs.filter(t => !t.adminOnly || isAdmin);

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <TopNav />
      <main className="flex flex-col mt-14 h-[calc(100dvh-3.5rem)] overflow-hidden">
        {/* Header */}
        <div className="shrink-0 border-b border-border bg-background px-6 py-4">
          <h1 className="text-lg font-bold tracking-tight leading-none">Settings</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Account and administration</p>
        </div>

        {/* Sub-tabs */}
        <div className="shrink-0 border-b border-border px-6 py-2 bg-background">
          {/* No explicit generic on TabBar — Replit's vite metadata plugin can't parse generic JSX call sites (`<TabBar<Tab> …>`) and corrupts the transform; T is inferred from props anyway. */}
          <TabBar tabs={visibleTabs} active={tab} onChange={(id) => setTab(id)} />
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === "profile" && <ProfileTab />}
          {tab === "trading" && <TradingTab />}
          {tab === "scorecard-guide" && <ScorecardGuideContent showHeader={false} />}
          {tab === "users"   && isAdmin && <UserMgmtTab />}
          {tab === "cache"       && isAdmin && <CacheMonitorTab />}
          {tab === "scheduled-tasks" && isAdmin && <ScheduledTasksTab />}
          {tab === "stockdb"     && <StockDBTab />}
          {tab === "api-monitor" && isAdmin && <ApiMonitorTab />}
          {tab === "feedback"    && isAdmin && <FeedbackTab />}
        </div>
      </main>
    </div>
  );
}
