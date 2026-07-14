import { useCallback, useMemo, lazy, Suspense, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider, QueryErrorResetBoundary } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { ScoringPreferencesProvider } from "@/context/ScoringPreferencesContext";
import { RouteErrorBoundary } from "@/components/RouteErrorBoundary";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useSessionState } from "@/hooks/use-session-state";
import Login from "@/pages/login";

const NotFound = lazy(() => import("@/pages/not-found"));
const Rankings = lazy(() => import("@/pages/rankings"));
const Home = lazy(() => import("@/pages/home"));
const Watchlist = lazy(() => import("@/pages/watchlist"));
const Technical = lazy(() => import("@/pages/technical"));
const Portfolio = lazy(() => import("@/pages/portfolio"));
const ScorecardExplanation = lazy(() => import("@/pages/scorecard-explanation"));
const OptionsScanner = lazy(() => import("@/pages/options-scanner"));
const Macro = lazy(() => import("@/pages/macro"));
const Settings = lazy(() => import("@/pages/settings"));
const Profile = lazy(() => import("@/pages/profile"));
const Feed = lazy(() => import("@/pages/feed"));
const Sentiment = lazy(() => import("@/pages/sentiment"));

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
  if (isLoading) {
    return (
      <div className="min-h-[100dvh] bg-background flex items-center justify-center">
        <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>
      </div>
    );
  }
  if (!user) return <Redirect to="/login" />;
  return <RouteBoundary>{children}</RouteBoundary>;
}

function Router() {
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
        <ProtectedRoute>
          <Home tickers={tickers} setTickers={setTickers} />
        </ProtectedRoute>
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
        <Redirect to="/watchlist" />
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
        <ProtectedRoute><Macro /></ProtectedRoute>
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
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
        </ScoringPreferencesProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
