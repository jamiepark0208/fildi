import { useState } from "react";
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

function Router() {
  const [tickers, setTickers] = useState<string[]>([]);

  return (
    <Switch>
      <Route path="/">
        <Home tickers={tickers} setTickers={setTickers} />
      </Route>
      <Route path="/watchlist" component={Watchlist} />
      <Route path="/technical" component={Technical} />
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
