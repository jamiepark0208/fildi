/**
 * Fire-and-forget UI crash → /api/client/ui-crash → ~/.fildi/ui-crashes.jsonl.
 * Agents read that on session start (no Sentry required).
 */
const lastSent = new Map<string, number>();

export function reportUiCrash(opts: {
  message: string;
  source: string;
  stack?: string | null;
}): void {
  const message = (opts.message || "unknown").slice(0, 500);
  const now = Date.now();
  const prev = lastSent.get(message) ?? 0;
  if (now - prev < 60_000) return;
  lastSent.set(message, now);

  const payload = JSON.stringify({
    message,
    path: typeof window !== "undefined" ? window.location.pathname : "",
    source: opts.source,
    stack: opts.stack ?? null,
  });

  try {
    // keepalive so boundary teardown / unload still delivers
    void fetch("/api/client/ui-crash", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => { /* offline / 401 — ignore */ });
  } catch { /* ignore */ }
}
