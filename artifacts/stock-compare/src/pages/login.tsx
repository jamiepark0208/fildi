import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";

type Tab = "signin" | "register";

export default function Login() {
  const [tab, setTab] = useState<Tab>("signin");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { user, refetch } = useAuth();
  const [, navigate] = useLocation();

  // Navigate once auth state is confirmed — avoids race where ProtectedRoute
  // sees stale null user between refetch() resolving and React re-rendering.
  useEffect(() => {
    if (user) navigate("/profile/me");
  }, [user]);

  async function handleSignIn(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: fd.get("email"), password: fd.get("password") }),
      });
      const data = await res.json();
      const errMsg = data.error ?? data.message;
      if (!res.ok) { setError(errMsg ?? "Login failed"); return; }
      const me = await refetch();
      if (!me.data) {
        setError("Signed in but session did not persist — check SESSION_SECRET and server logs");
        return;
      }
      // navigation handled by useEffect watching user
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const fd = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: fd.get("email"),
          username: fd.get("username"),
          password: fd.get("password"),
          inviteCode: fd.get("inviteCode"),
        }),
      });
      const data = await res.json();
      const errMsg = data.error ?? data.message;
      if (!res.ok) { setError(errMsg ?? "Registration failed"); return; }
      const me = await refetch();
      if (!me.data) {
        setError("Account created but session did not persist — check SESSION_SECRET and server logs");
        return;
      }
      // navigation handled by useEffect watching user
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-black text-foreground flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center mb-8">
          <img
            src="/fildi-logo.png"
            alt="Fildi"
            className="w-40 h-40 rounded-2xl object-cover shadow-[0_0_30px_-8px_rgba(212,175,55,0.35)] border border-[#d4af37]/30"
          />
        </div>

        <div className="bg-gradient-to-b from-[#1a1a1a] to-black border border-[#d4af37]/25 rounded-xl p-6 shadow-[0_0_40px_-12px_rgba(212,175,55,0.2)]">
          <div className="flex border border-[#d4af37]/20 rounded-lg p-1 mb-5 gap-1">
            {(["signin", "register"] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setError(null); }}
                className={cn(
                  "flex-1 text-sm py-1.5 rounded-md font-medium transition-colors",
                  tab === t ? "bg-[#d4af37] text-black" : "text-muted-foreground hover:text-[#d4af37]"
                )}
              >
                {t === "signin" ? "Sign In" : "Register"}
              </button>
            ))}
          </div>

          {tab === "signin" ? (
            <form onSubmit={handleSignIn} className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Email</label>
                <input
                  name="email" type="email" required autoComplete="email"
                  className="w-full bg-black/60 border border-[#d4af37]/20 rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[#d4af37]"
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Password</label>
                <input
                  name="password" type="password" required autoComplete="current-password"
                  className="w-full bg-black/60 border border-[#d4af37]/20 rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[#d4af37]"
                  placeholder="••••••••"
                />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit" disabled={loading}
                className="w-full bg-[#d4af37] text-black text-sm font-semibold py-2 rounded-md hover:bg-[#c9a02e] transition-colors disabled:opacity-50 mt-1"
              >
                {loading ? "Signing in…" : "Sign In"}
              </button>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-3">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Email</label>
                <input
                  name="email" type="email" required autoComplete="email"
                  className="w-full bg-black/60 border border-[#d4af37]/20 rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[#d4af37]"
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Username</label>
                <input
                  name="username" type="text" required autoComplete="username"
                  className="w-full bg-black/60 border border-[#d4af37]/20 rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[#d4af37]"
                  placeholder="yourname"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Password</label>
                <input
                  name="password" type="password" required autoComplete="new-password"
                  className="w-full bg-black/60 border border-[#d4af37]/20 rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[#d4af37]"
                  placeholder="••••••••"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Invite Code</label>
                <input
                  name="inviteCode" type="text" required
                  className="w-full bg-black/60 border border-[#d4af37]/20 rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[#d4af37] uppercase"
                  placeholder="XXXXXXXX"
                />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit" disabled={loading}
                className="w-full bg-[#d4af37] text-black text-sm font-semibold py-2 rounded-md hover:bg-[#c9a02e] transition-colors disabled:opacity-50 mt-1"
              >
                {loading ? "Creating account…" : "Create Account"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
