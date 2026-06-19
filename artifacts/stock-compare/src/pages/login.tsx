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
    if (user) navigate("/");
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
    <div className="min-h-[100dvh] bg-background text-foreground flex items-center justify-center">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-8 h-8 rounded-md bg-primary flex items-center justify-center">
            <svg className="w-4 h-4 text-primary-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 12l3-3 3 3 4-4M8 21l4-4 4 4M3 4h18M4 4h16v12a1 1 0 01-1 1H5a1 1 0 01-1-1V4z" />
            </svg>
          </div>
          <span className="font-bold tracking-tight text-xl text-foreground">FILDI</span>
        </div>

        <div className="bg-card border border-border rounded-xl p-6 shadow-sm">
          <div className="flex border border-border rounded-lg p-1 mb-5 gap-1">
            {(["signin", "register"] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => { setTab(t); setError(null); }}
                className={cn(
                  "flex-1 text-sm py-1.5 rounded-md font-medium transition-colors",
                  tab === t ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
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
                  className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Password</label>
                <input
                  name="password" type="password" required autoComplete="current-password"
                  className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="••••••••"
                />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit" disabled={loading}
                className="w-full bg-primary text-primary-foreground text-sm font-medium py-2 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50 mt-1"
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
                  className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="you@example.com"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Username</label>
                <input
                  name="username" type="text" required autoComplete="username"
                  className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="yourname"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Password</label>
                <input
                  name="password" type="password" required autoComplete="new-password"
                  className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="••••••••"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Invite Code</label>
                <input
                  name="inviteCode" type="text" required
                  className="w-full bg-secondary border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary uppercase"
                  placeholder="XXXXXXXX"
                />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <button
                type="submit" disabled={loading}
                className="w-full bg-primary text-primary-foreground text-sm font-medium py-2 rounded-md hover:opacity-90 transition-opacity disabled:opacity-50 mt-1"
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
