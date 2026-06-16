import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Sidebar } from "@/components/sidebar";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";
import { Copy, Check, Plus } from "lucide-react";

interface InviteCode {
  code: string;
  createdBy: number;
  usedBy: number | null;
  createdAt: string;
  usedAt: string | null;
}

function AdminSection() {
  const queryClient = useQueryClient();
  const [latestCode, setLatestCode] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: invites = [], isLoading } = useQuery<InviteCode[]>({
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
      const res = await fetch("/api/admin/invite", {
        method: "POST",
        credentials: "include",
      });
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

  return (
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
      <h2 className="text-sm font-semibold mb-4">Invite Codes</h2>

      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={generateCode}
          disabled={generating}
          className="flex items-center gap-2 text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50"
        >
          <Plus className="w-3 h-3" />
          {generating ? "Generating…" : "Generate Invite Code"}
        </button>
      </div>

      {latestCode && (
        <div className="flex items-center gap-2 mb-5">
          <input
            readOnly
            value={latestCode}
            className="font-mono text-sm bg-secondary border border-border rounded-md px-3 py-1.5 w-36 text-foreground focus:outline-none"
          />
          <button
            onClick={copyCode}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2.5 py-1.5 transition-colors"
          >
            {copied ? <Check className="w-3 h-3 text-green-400" /> : <Copy className="w-3 h-3" />}
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      )}

      {isLoading ? (
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
            </tr>
          </thead>
          <tbody className="divide-y divide-border/40">
            {invites.map((inv) => (
              <tr key={inv.code} className="h-8">
                <td className="font-mono font-bold">{inv.code}</td>
                <td className="text-muted-foreground">
                  {new Date(inv.createdAt).toLocaleDateString()}
                </td>
                <td>
                  {inv.usedBy ? (
                    <span className="text-muted-foreground">Used</span>
                  ) : (
                    <span className={cn(
                      "text-xs font-semibold px-2 py-0.5 rounded border",
                      "bg-green-500/15 text-green-400 border-green-500/30"
                    )}>Pending</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Settings() {
  const { user, isAdmin } = useAuth();

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex">
      <Sidebar />
      <main className="flex-1 overflow-y-auto" style={{ marginLeft: 'var(--sidebar-w, 220px)', transition: 'margin-left 200ms ease' }}>
        <div className="shrink-0 border-b border-border bg-background px-6 py-4">
          <h1 className="text-lg font-bold tracking-tight leading-none">Settings</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Account and administration</p>
        </div>

        <div className="p-6 space-y-6 max-w-2xl">
          {/* Account section */}
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
            </div>
          </div>

          {/* Admin section */}
          {isAdmin && <AdminSection />}
        </div>
      </main>
    </div>
  );
}
