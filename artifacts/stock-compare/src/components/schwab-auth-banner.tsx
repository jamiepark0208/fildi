/**
 * A73: persistent Schwab re-auth / outage banner (polls /api/schwab/status).
 * Shows when refresh token ≤2d, expired, or unauthed during market hours (06:30–13:00 PT).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";

type SchwabStatus = {
  configured: boolean;
  clientReady: boolean;
  hasTokens: boolean;
  accessValid: boolean;
  refreshDaysLeft: number | null;
  refreshExpiresAt: string | null;
  warningLevel: "ok" | "warn" | "urgent" | "down";
  reauthHint: string | null;
  obtainedAt: string | null;
};

function isSchwabWatchWindow(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value ?? "";
  if (["Sat", "Sun"].includes(wd)) return false;
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const mins = hour * 60 + minute;
  return mins >= 6 * 60 + 30 && mins < 13 * 60;
}

function formatExpiry(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return null;
  }
}

export function SchwabAuthBanner() {
  const { user } = useAuth();
  const qc = useQueryClient();
  const { data } = useQuery<SchwabStatus>({
    queryKey: ["schwab-status"],
    queryFn: async () => {
      const res = await fetch("/api/schwab/status", { credentials: "include" });
      if (!res.ok) throw new Error("schwab status");
      return res.json();
    },
    enabled: !!user,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const startOAuth = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/schwab/oauth/start", {
        method: "POST",
        credentials: "include",
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "oauth start failed");
      return body as { authorizeUrl: string };
    },
    onSuccess: (body) => {
      window.open(body.authorizeUrl, "schwab-oauth", "noopener,noreferrer");
      const t0 = Date.now();
      const poll = window.setInterval(async () => {
        try {
          const r = await fetch("/api/schwab/oauth/status", { credentials: "include" });
          const s = await r.json();
          if (s.status === "done" || s.status === "error" || Date.now() - t0 > 200_000) {
            window.clearInterval(poll);
            void qc.invalidateQueries({ queryKey: ["schwab-status"] });
          }
        } catch {
          /* keep polling */
        }
      }, 2000);
    },
  });

  if (!user || !data) return null;

  const watch = isSchwabWatchWindow();
  const level = data.warningLevel;
  const show =
    level === "warn" ||
    level === "urgent" ||
    level === "down" ||
    (watch && !data.clientReady);

  if (!show) return null;

  const expiry = formatExpiry(data.refreshExpiresAt);
  const days = data.refreshDaysLeft != null ? data.refreshDaysLeft.toFixed(1) : null;
  const tone =
    level === "down" || (watch && !data.clientReady)
      ? "border-red-500/40 bg-red-950/80 text-red-100"
      : level === "urgent"
        ? "border-amber-500/50 bg-amber-950/80 text-amber-50"
        : "border-amber-500/30 bg-amber-950/60 text-amber-100";

  const msg =
    level === "down" || (watch && !data.clientReady && level === "ok")
      ? data.reauthHint ?? "Schwab market data is down — quotes/chains fall back to Yahoo until re-auth."
      : days != null
        ? `Schwab re-auth needed within ${days}d${expiry ? ` (expires ${expiry} PT)` : ""} — one click.`
        : data.reauthHint ?? "Schwab re-auth needed soon.";

  return (
    <div
      role="status"
      className={cn(
        "sticky top-0 z-50 border-b px-3 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]",
        tone,
      )}
    >
      <span className="font-semibold uppercase tracking-wide text-[10px] opacity-80">Schwab</span>
      <span className="flex-1 min-w-[12rem]">{msg}</span>
      <button
        type="button"
        disabled={startOAuth.isPending}
        onClick={() => startOAuth.mutate()}
        className="shrink-0 rounded border border-current/30 px-2 py-0.5 font-semibold hover:bg-white/10 disabled:opacity-50"
      >
        {startOAuth.isPending ? "Starting…" : "Re-auth Schwab"}
      </button>
      {startOAuth.isError && (
        <span className="text-red-300">{(startOAuth.error as Error)?.message ?? "failed"}</span>
      )}
    </div>
  );
}
