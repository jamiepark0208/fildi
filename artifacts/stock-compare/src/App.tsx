import { useState, useCallback, type Dispatch, type SetStateAction } from "react";
import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { ScoringPreferencesProvider } from "@/context/ScoringPreferencesContext";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Watchlist from "@/pages/watchlist";
import Technical from "@/pages/technical";
import Breakdown from "@/pages/breakdown";
import Portfolio from "@/pages/portfolio";
import ScorecardExplanation from "@/pages/scorecard-explanation";
import OptionsScanner from "@/pages/options-scanner";
import Macro from "@/pages/macro";
import Login from "@/pages/login";
import Settings from "@/pages/settings";
import Profile from "@/pages/profile";
import Feed from "@/pages/feed";
import Sentiment from "@/pages/sentiment";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function useSessionState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [val, set] = useState<T>(() => {
    try {
      const v = sessionStorage.getItem(key);
      return v ? JSON.parse(v) : initial;
    } catch { return initial; }
  });
  const setVal = useCallback<Dispatch<SetStateAction<T>>>(action => {
    set(prev => {
      const next = typeof action === "function" ? (action as (p: T) => T)(prev) : action;
      try { sessionStorage.setItem(key, JSON.stringify(next)); } catch {}
      return next;
    });
  }, [key]);
  return [val, setVal];
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
  return <>{children}</>;
}

function Router() {
  const [tickers, setTickers] = useSessionState<string[]>("fildi_tickers", []);

  return (
    <Switch>
      <Route path="/login" component={Login} />
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
        <ProtectedRoute><Breakdown /></ProtectedRoute>
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
      <Route component={NotFound} />
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
