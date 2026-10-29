import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogOut, Settings2 } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { getTraderPrefs, saveTraderPrefs, DEFAULT_TRADER_PREFS } from "@/lib/trader-prefs";

/** Compact trading prefs — lives on Profile (owner) after Settings Profile tab removal. */
export function TradingPrefsStrip() {
  const { user, isAdmin } = useAuth();
  const [, navigate] = useLocation();
  const [minWeeklyIncome, setMinWeeklyIncome] = useState(() => getTraderPrefs(user?.id).minWeeklyIncome);
  const [input, setInput] = useState(() => String(getTraderPrefs(user?.id).minWeeklyIncome));
  const [saved, setSaved] = useState(false);

  const { data: briefCtx } = useQuery<{ strategy: string; userNotes: string }>({
    queryKey: ["daily-brief-context"],
    queryFn: async () => {
      const r = await fetch("/api/daily-brief/context", { credentials: "include" });
      if (!r.ok) throw new Error();
      return r.json();
    },
    staleTime: 60_000,
  });

  const handleSave = () => {
    const n = parseFloat(input);
    if (!Number.isFinite(n) || n < 0) return;
    setMinWeeklyIncome(n);
    saveTraderPrefs({ minWeeklyIncome: n }, user?.id);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[#d4af37]/80">Trading</span>
        <span className="text-xs text-zinc-300">Min income ≥</span>
        <div className="flex items-center gap-1 border border-zinc-600 rounded px-1.5 h-6">
          <input
            type="number"
            min="0"
            step="0.1"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            className="w-10 text-xs bg-transparent text-white focus:outline-none text-center"
          />
          <span className="text-[11px] text-amber-100">%/wk</span>
        </div>
        <button
          type="button"
          onClick={handleSave}
          className="text-[11px] font-semibold px-2 h-6 rounded border border-[#d4af37]/40 text-[#d4af37] hover:bg-[#d4af37]/10"
        >
          {saved ? "Saved" : "Save"}
        </button>
        {minWeeklyIncome !== DEFAULT_TRADER_PREFS.minWeeklyIncome && (
          <button
            type="button"
            onClick={() => {
              setInput(String(DEFAULT_TRADER_PREFS.minWeeklyIncome));
              setMinWeeklyIncome(DEFAULT_TRADER_PREFS.minWeeklyIncome);
              saveTraderPrefs(DEFAULT_TRADER_PREFS, user?.id);
            }}
            className="text-[11px] text-amber-100 hover:text-white"
          >
            Reset
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            try {
              sessionStorage.setItem("fildi_settings_tab", JSON.stringify("scorecard-guide"));
            } catch {
              /* ignore */
            }
            navigate("/settings");
          }}
          className="text-[11px] text-[#d4af37] hover:underline ml-auto"
        >
          Scorecard Guide →
        </button>
      </div>
      <p className="text-[11px] text-amber-100 truncate">
        Brief ·{" "}
        {isAdmin ? (
          <button type="button" onClick={() => navigate("/portfolio")} className="text-[#d4af37] hover:underline">
            edit on Portfolio
          </button>
        ) : (
          <>
            <span className="text-zinc-200">{briefCtx?.strategy || "—"}</span>
            {briefCtx?.userNotes ? ` · ${briefCtx.userNotes}` : ""}
          </>
        )}
      </p>
    </div>
  );
}

/**
 * Owner-only account sheet — email / role / password / logout.
 * Trigger sits next to the role badge on Profile.
 */
export function AccountDetailsButton() {
  const { user, refetch } = useAuth();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwSuccess, setPwSuccess] = useState(false);
  const [pwSubmitting, setPwSubmitting] = useState(false);

  const handleLogout = async () => {
    try {
      sessionStorage.setItem("fildi_explicit_logout", "1");
      sessionStorage.removeItem("fildi_auth_user_v1");
      sessionStorage.removeItem("fildi_return_to");
    } catch { /* */ }
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          title="Account details"
          aria-label="Account details"
          className="inline-flex items-center justify-center h-6 w-6 rounded border border-zinc-600 text-zinc-300 hover:text-[#d4af37] hover:border-[#d4af37]/50 transition-colors"
        >
          <Settings2 className="w-3.5 h-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="bg-zinc-950 border-[#d4af37]/30 text-zinc-100 sm:max-w-md p-4 gap-3">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold text-white">Account</DialogTitle>
        </DialogHeader>

        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="text-amber-100">Email</span>
            <span className="font-mono text-white truncate">{user?.email}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-amber-100">Username</span>
            <span className="font-mono text-white">{user?.username}</span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-amber-100">Role</span>
            <span
              className={cn(
                "font-semibold px-2 py-0.5 rounded border",
                user?.role === "admin"
                  ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
                  : "bg-zinc-900 text-zinc-300 border-zinc-600",
              )}
            >
              {user?.role}
            </span>
          </div>
        </div>

        <div className="border-t border-zinc-800 pt-3 space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#d4af37]/80">
            <KeyRound className="w-3.5 h-3.5" />
            Password
          </div>
          <form onSubmit={handleChangePassword} className="space-y-1.5">
            <input
              type="password"
              placeholder="Current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              required
              className="w-full text-xs bg-zinc-900 border border-zinc-600 rounded-md px-3 py-1.5 text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50"
            />
            <input
              type="password"
              placeholder="New password (min 8)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              minLength={8}
              required
              className="w-full text-xs bg-zinc-900 border border-zinc-600 rounded-md px-3 py-1.5 text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50"
            />
            <input
              type="password"
              placeholder="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              minLength={8}
              required
              className="w-full text-xs bg-zinc-900 border border-zinc-600 rounded-md px-3 py-1.5 text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50"
            />
            {pwError && <p className="text-xs text-red-400">{pwError}</p>}
            {pwSuccess && <p className="text-xs text-emerald-400">Password updated.</p>}
            <button
              type="submit"
              disabled={pwSubmitting}
              className="text-xs font-semibold bg-[#d4af37] text-black px-3 py-1.5 rounded-md hover:bg-[#e0bd4a] disabled:opacity-50"
            >
              {pwSubmitting ? "Updating…" : "Update password"}
            </button>
          </form>
        </div>

        <button
          type="button"
          onClick={() => void handleLogout()}
          className="flex items-center gap-2 text-xs text-amber-100 hover:text-red-400 transition-colors pt-1 border-t border-zinc-800"
        >
          <LogOut className="w-3.5 h-3.5" />
          Log out
        </button>
      </DialogContent>
    </Dialog>
  );
}
