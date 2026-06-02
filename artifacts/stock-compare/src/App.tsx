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

const queryClient = new QueryClient();

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
  const [fundamentalTickers, setFundamentalTickers] = useSessionState<string[]>("fildi_fund_tickers", []);
  const [technicalTickers,   setTechnicalTickers]   = useSessionState<string[]>("fildi_tech_tickers", []);

  return (
    <Switch>
      <Route path="/">
        <Home tickers={fundamentalTickers} setTickers={setFundamentalTickers} />
      </Route>
      <Route path="/watchlist" component={Watchlist} />
      <Route path="/technical">
        <Technical tickers={technicalTickers} setTickers={setTechnicalTickers} />
      </Route>
      <Route path="/breakdown" component={Breakdown} />
      <Route path="/portfolio" component={Portfolio} />
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
