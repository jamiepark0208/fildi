import * as Sentry from "@sentry/react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

if (import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: import.meta.env.VITE_SENTRY_DSN as string,
    environment: import.meta.env.MODE,
    tracesSampleRate: 0,
  });
}

const SentryErrorBoundary = Sentry.ErrorBoundary ?? (({ children }: { children: React.ReactNode }) => <>{children}</>);

createRoot(document.getElementById("root")!).render(
  <SentryErrorBoundary fallback={
    <div className="flex items-center justify-center h-screen text-muted-foreground text-sm">
      Something went wrong. Please refresh.
    </div>
  }>
    <App />
  </SentryErrorBoundary>,
);
