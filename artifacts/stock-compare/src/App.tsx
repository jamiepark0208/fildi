import { useCallback, useEffect, useMemo, lazy, Suspense, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, QueryErrorResetBoundary } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth, readCachedUser } from "@/context/AuthContext";
import { ScoringPreferencesProvider } from "@/context/ScoringPreferencesContext";
import { StockNavProvider } from "@/context/StockNavContext";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { FeedbackWidget } from "@/components/FeedbackWidget";
import { SchwabAuthBanner } from "@/components/schwab-auth-banner";
import { LenisProvider } from "@/components/lenis-provider";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useSessionState } from "@/hooks/use-session-state";
import { idlePrefetchRouteChunks } from "@/lib/prefetch-policy";
import Login from "@/pages/login";
import { useTicket } from "@/lib/trade-ticket-store";

const TradeTicketDock = lazy(() => import("@/components/trade-ticket/TradeTicketDock").then((m) => ({ default: m.TradeTicketDock })));
/** Loads the payoff dock chunk only once a leg exists. */
function TicketGate() {
  const { legs } = useTicket();
  return legs.length ? <Suspense fallback={null}><TradeTicketDock /></Suspense> : null;
}
const NotFound = lazy(() => import("@/pages/not-found"));
const Rankings = lazy(() => import("@/pages/rankings"));
const Today = lazy(() => import("@/pages/today"));
const Watchlist = lazy(() => import("@/pages/watchlist"));
const Technical = lazy(() => import("@/pages/technical"));
const Portfolio = lazy(() => import("@/pages/portfolio"));
const ScorecardExplanation = lazy(() => import("@/pages/scorecard-explanation"));
const OptionsScanner = lazy(() => import("@/pages/options-scanner"));
const Settings = lazy(() => import("@/pages/settings"));
const Profile = lazy(() => import("@/pages/profile"));
const Feed = lazy(() => import("@/pages/feed"));
const Sentiment = lazy(() => import("@/pages/sentiment"));
const Live = lazy(() => import("@/pages/live"));
const Agents = lazy(() => import("@/pages/agents"));
const BacktestLab = lazy(() => import("@/pages/backtest-lab"));

/** Old /macro bookmarks → Live › Macro (keeps ?tab=). */
function MacroToLiveRedirect() {
  const params = new URLSearchParams(typeof window !== "undefined" ? window.location.search : "");
  params.set("page", "macro");
  const q = params.toString();
  return <Redirect to={`/live${q ? `?${q}` : ""}`} />;
}

/** Old /track-record bookmarks → Live › Track Record. */
function TrackRecordToLiveRedirect() {
  return <Redirect to="/live?page=track" />;
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 5 * 60 * 1000,
    },
  },
});

function RouteBoundary({ children }: { children: ReactNode }) {
  return (
    <QueryErrorResetBoundary>
      {({ reset }) => (
        <RouteErrorBoundary onReset={reset}>
          <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
        </RouteErrorBoundary>
      )}
    </QueryErrorResetBoundary>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  // Sticky across Vite HMR / API restarts — never kick to login while the
  // browser still has a cached session user.
  const stickyUser = user ?? readCachedUser();
  if (isLoading && !stickyUser) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <span className="text-xs text-amber-100 animate-pulse">Loading…</span>
      </div>
    );
  }
  if (!stickyUser) {
    try {
      const path = `${window.location.pathname}${window.location.search}`;
      if (path && !path.startsWith("/login")) {
        sessionStorage.setItem("fildi_return_to", path);
      }
    } catch { /* private mode */ }
    return <Redirect to="/login" />;
  }
  return <RouteBoundary>{children}</RouteBoundary>;
}

function Router() {
  const { user } = useAuth();
  // Once logged in, quietly warm every other tab's JS chunk in an idle callback —
  // JS only, never data (see prefetch-policy.ts), so it's safe regardless of which
  // tab the user actually opens next.
  useEffect(() => {
    if (user) idlePrefetchRouteChunks();
  }, [user]);

  const [rawTickers, setRawTickers] = useSessionState<string[]>("fildi_tickers", []);
  // Dedupe defensively: a duplicate ticker here fans out into duplicate
  // useQueries keys (home.tsx, technical.tsx, price-chart.tsx), which React
  // Query flags as "Duplicate Queries" and can trigger redundant fetches.
  const tickers = useMemo(() => Array.from(new Set(rawTickers)), [rawTickers]);
  const setTickers = useCallback<Dispatch<SetStateAction<string[]>>>(action => {
    setRawTickers(prev => {
      const next = typeof action === "function" ? (action as (p: string[]) => string[])(prev) : action;
      return Array.from(new Set(next));
    });
  }, [setRawTickers]);

  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/rankings">
        <ProtectedRoute><Rankings /></ProtectedRoute>
      </Route>
      <Route path="/">
        <Redirect to="/watchlist" />
      </Route>
      <Route path="/watchlist">
        <ProtectedRoute><Watchlist /></ProtectedRoute>
      </Route>
      <Route path="/technical">
        <ProtectedRoute>
          <Technical tickers={tickers} setTickers={setTickers} />
        </ProtectedRoute>
      </Route>
      <Route path="/breakdown">
        {/* keep ?ticker= so old /breakdown links open that stock, not an empty Watchlist */}
        <Redirect to={`/watchlist${typeof window !== "undefined" ? window.location.search : ""}`} />
      </Route>
      <Route path="/portfolio">
        <ProtectedRoute><Portfolio /></ProtectedRoute>
      </Route>
      <Route path="/scorecard-explanation">
        <ProtectedRoute><ScorecardExplanation /></ProtectedRoute>
      </Route>
      <Route path="/options-scanner">
        <ProtectedRoute><OptionsScanner /></ProtectedRoute>
      </Route>
      <Route path="/macro">
        <ProtectedRoute><MacroToLiveRedirect /></ProtectedRoute>
      </Route>
      <Route path="/agents">
        <ProtectedRoute><Agents /></ProtectedRoute>
      </Route>
      <Route path="/backtest">
        <ProtectedRoute><BacktestLab /></ProtectedRoute>
      </Route>
      <Route path="/settings">
        <ProtectedRoute><Settings /></ProtectedRoute>
      </Route>
      <Route path="/profile/:username">
        <ProtectedRoute><Profile /></ProtectedRoute>
      </Route>
      <Route path="/feed">
        <ProtectedRoute><Feed /></ProtectedRoute>
      </Route>
      <Route path="/sentiment">
        <ProtectedRoute><Sentiment /></ProtectedRoute>
      </Route>
      <Route path="/today">
        <ProtectedRoute><Today /></ProtectedRoute>
      </Route>
      <Route path="/live">
        <ProtectedRoute><Live /></ProtectedRoute>
      </Route>
      <Route path="/track-record">
        <ProtectedRoute><TrackRecordToLiveRedirect /></ProtectedRoute>
      </Route>
      <Route>
        <Suspense fallback={<PageSkeleton />}>
          <NotFound />
        </Suspense>
      </Route>
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ScoringPreferencesProvider>
        <TooltipProvider delayDuration={200} skipDelayDuration={0}>
          <LenisProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <StockNavProvider>
              <SchwabAuthBanner />
              <Router />
            </StockNavProvider>
          </WouterRouter>
          <FeedbackWidget />
          <TicketGate />
          <Toaster />
          </LenisProvider>
        </TooltipProvider>
        </ScoringPreferencesProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
