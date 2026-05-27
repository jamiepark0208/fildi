import { useState } from "react";
import { useCompareStocks, getCompareStocksQueryKey } from "@workspace/api-client-react";
import { TickerInput } from "@/components/ticker-input";
import { Button } from "@/components/ui/button";
import { ArrowRight, BarChart2 } from "lucide-react";
import { Scorecard } from "@/components/scorecard";
import { ComparisonTable } from "@/components/comparison-table";

export default function Home() {
  const [ticker1, setTicker1] = useState("");
  const [ticker2, setTicker2] = useState("");
  const [activeCompare, setActiveCompare] = useState<{ t1: string; t2: string } | null>(null);

  const handleCompare = () => {
    if (ticker1 && ticker2) {
      setActiveCompare({ t1: ticker1, t2: ticker2 });
    }
  };

  const { data: compareData, isLoading, error } = useCompareStocks(
    { ticker1: activeCompare?.t1 || "", ticker2: activeCompare?.t2 || "" },
    {
      query: {
        enabled: !!activeCompare,
        queryKey: getCompareStocksQueryKey({ ticker1: activeCompare?.t1 || "", ticker2: activeCompare?.t2 || "" }),
      },
    }
  );

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-primary/30">
      <header className="border-b border-border/50 bg-card/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded bg-primary text-primary-foreground flex items-center justify-center font-bold">
              <BarChart2 className="w-5 h-5" />
            </div>
            <span className="font-bold tracking-tight">EQUITRON</span>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-12 max-w-5xl">
        <div className="mb-12">
          <h1 className="text-4xl md:text-5xl font-bold mb-4 tracking-tight">Comparative Analysis</h1>
          <p className="text-xl text-muted-foreground mb-8 max-w-2xl">
            Evaluate two public equities head-to-head. Analyze valuation, growth, and profitability to determine the optimal allocation.
          </p>

          <div className="grid md:grid-cols-[1fr_1fr_auto] gap-4 items-end bg-card p-6 rounded-xl border border-border shadow-sm">
            <TickerInput
              label="Asset Alpha"
              id="asset-alpha"
              value={ticker1}
              onChange={setTicker1}
              placeholder="e.g. AAPL"
            />
            <TickerInput
              label="Asset Beta"
              id="asset-beta"
              value={ticker2}
              onChange={setTicker2}
              placeholder="e.g. MSFT"
            />
            <Button
              size="lg"
              className="h-12 w-full md:w-auto font-bold tracking-wide"
              onClick={handleCompare}
              disabled={!ticker1 || !ticker2 || isLoading}
              data-testid="button-compare"
            >
              {isLoading ? "COMPUTING..." : "COMPARE"}
              {!isLoading && <ArrowRight className="ml-2 w-4 h-4" />}
            </Button>
          </div>
        </div>

        {error && (
          <div className="p-6 bg-destructive/10 border border-destructive/20 rounded-xl text-destructive">
            <h3 className="font-bold mb-2">Analysis Failed</h3>
            <p>Unable to retrieve comparison data. Please verify the ticker symbols and try again.</p>
          </div>
        )}

        {isLoading && (
          <div className="space-y-8 animate-pulse opacity-50">
            <div className="h-64 bg-card rounded-xl border border-border"></div>
            <div className="h-96 bg-card rounded-xl border border-border"></div>
          </div>
        )}

        {compareData && (
          <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <ComparisonTable stock1={compareData.stock1} stock2={compareData.stock2} />
            <Scorecard
              scorecard={compareData.scorecard}
              stock1={compareData.stock1}
              stock2={compareData.stock2}
            />
          </div>
        )}
      </main>
    </div>
  );
}
