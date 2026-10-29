import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { reportUiCrash } from "@/lib/report-ui-crash";

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN as string,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
  });
}

// LWC / effect throws often miss React error boundaries — still land in agent bus.
window.addEventListener("error", (ev) => {
  const msg = ev.error?.message ?? ev.message ?? "";
  if (!msg || /ResizeObserver|Script error/i.test(msg)) return;
  reportUiCrash({
    message: String(msg),
    source: "window.error",
    stack: ev.error?.stack ?? null,
  });
});
window.addEventListener("unhandledrejection", (ev) => {
  const reason = ev.reason;
  const msg = reason instanceof Error ? reason.message : String(reason ?? "");
  if (!msg) return;
  reportUiCrash({
    message: msg,
    source: "unhandledrejection",
    stack: reason instanceof Error ? reason.stack ?? null : null,
  });
});

// Vite HMR: after a rebuild, old lazy-route chunk URLs 404. Without this the
// app flashes NotFound ("Did you forget…") / error, then a messy remount that
// looks like a logout. One clean reload picks up the new hashes.
const PRELOAD_RELOAD_KEY = "fildi_vite_preload_reload";
window.addEventListener("vite:preloadError", ((event: Event) => {
  event.preventDefault();
  try {
    const n = Number(sessionStorage.getItem(PRELOAD_RELOAD_KEY) || "0");
    if (n >= 1) return; // already reloaded once — don't loop
    sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(n + 1));
  } catch { /* */ }
  window.location.reload();
}) as EventListener);
// Drop the guard after a healthy boot so a later HMR can recover again.
window.setTimeout(() => {
  try { sessionStorage.removeItem(PRELOAD_RELOAD_KEY); } catch { /* */ }
}, 3000);

const SentryErrorBoundary = Sentry.ErrorBoundary ?? (({ children }: { children: React.ReactNode }) => <>{children}</>);

createRoot(document.getElementById("root")!).render(
  <SentryErrorBoundary fallback={
    <div className="flex items-center justify-center h-screen text-amber-100 text-sm">
      Something went wrong. Please refresh.
    </div>
  }>
    <App />
  </SentryErrorBoundary>,
);
