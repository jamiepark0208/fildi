import { useState, useCallback, type Dispatch, type SetStateAction } from "react";
import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Watchlist from "@/pages/watchlist";
import Technical from "@/pages/technical";
import Breakdown from "@/pages/breakdown";
import Portfolio from "@/pages/portfolio";
import ScorecardExplanation from "@/pages/scorecard-explanation";
import OptionsScanner from "@/pages/options-scanner";
import Macro from "@/pages/macro";

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

function Router() {
  const [tickers, setTickers] = useSessionState<string[]>("fildi_tickers", []);

  return (
    <Switch>
      <Route path="/">
        <Home tickers={tickers} setTickers={setTickers} />
      </Route>
      <Route path="/watchlist" component={Watchlist} />
      <Route path="/technical">
        <Technical tickers={tickers} setTickers={setTickers} />
      </Route>
      <Route path="/breakdown" component={Breakdown} />
      <Route path="/portfolio" component={Portfolio} />
      <Route path="/scorecard-explanation" component={ScorecardExplanation} />
      <Route path="/options-scanner" component={OptionsScanner} />
      <Route path="/macro" component={Macro} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
