import { StockMetrics } from "@workspace/api-client-react";
import { formatCurrency, formatPercent, formatNumber, formatLargeNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

interface MetricsTableProps {
  stocks: StockMetrics[];
  loadingTickers: Record<string, boolean>;
}

interface MetricRowProps {
  label: string;
  stocks: StockMetrics[];
  loadingTickers: Record<string, boolean>;
  getValue: (s: StockMetrics) => number | null | undefined;
  formatValue: (v: number | null | undefined) => React.ReactNode;
  higherIsBetter?: boolean;
  lowerIsBetter?: boolean;
  validFilter?: (v: number) => boolean;
}

function MetricRow({ label, stocks, loadingTickers, getValue, formatValue, higherIsBetter, lowerIsBetter, validFilter }: MetricRowProps) {
  let winnerIndices: number[] = [];

  if ((higherIsBetter || lowerIsBetter) && stocks.length >= 2) {
    const values = stocks.map(s => getValue(s));
    let bestValue = higherIsBetter ? -Infinity : Infinity;

    values.forEach((v) => {
      if (v != null && isFinite(v) && (validFilter == null || validFilter(v))) {
        if (higherIsBetter && v > bestValue) bestValue = v;
        if (lowerIsBetter && v < bestValue) bestValue = v;
      }
    });

    if (isFinite(bestValue)) {
      values.forEach((v, i) => {
        if (v === bestValue && (validFilter == null || validFilter(v))) winnerIndices.push(i);
      });
    }
  }

  return (
    <tr className="border-b border-border/50 hover:bg-secondary/10 transition-colors group">
      <td className="p-3 text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors sticky left-0 bg-card group-hover:bg-card">
        {label}
      </td>
      {stocks.map((stock, i) => {
        const isWinner = winnerIndices.includes(i);
        const isLoading = loadingTickers[stock.ticker];
        
        return (
          <td 
            key={stock.ticker}
            className={cn(
              "p-3 text-right font-mono text-sm min-w-[120px]",
              isWinner && !isLoading ? "text-primary font-bold bg-primary/5" : "text-foreground"
            )}
          >
            {isLoading ? (
              <span className="inline-flex justify-end w-full"><Loader2 className="w-4 h-4 animate-spin text-muted-foreground" /></span>
            ) : (
              formatValue(getValue(stock))
            )}
          </td>
        );
      })}
    </tr>
  );
}

function SectionHeader({ title, colSpan }: { title: string; colSpan: number }) {
  return (
    <tr className="bg-secondary/30">
      <td colSpan={colSpan} className="p-3 text-xs font-bold uppercase tracking-wider text-foreground">
        {title}
      </td>
    </tr>
  );
}

export function MetricsTable({ stocks, loadingTickers }: MetricsTableProps) {
  if (stocks.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-max">
          <thead>
            <tr className="border-b border-border bg-card">
              <th className="p-4 font-semibold text-muted-foreground sticky left-0 bg-card z-10 w-48">Metric</th>
              {stocks.map((stock) => (
                <th key={stock.ticker} className="p-4 font-bold text-xl text-right">
                  <div className="flex flex-col items-end gap-1">
                    {loadingTickers[stock.ticker] ? (
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          {stock.logoUrl && <img src={stock.logoUrl} alt="" className="w-5 h-5 rounded bg-white" />}
                          <span>{stock.ticker}</span>
                        </div>
                        <span className="text-xs font-normal text-muted-foreground truncate max-w-[120px]">{stock.companyName}</span>
                      </>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* Overview */}
            <SectionHeader title="Overview" colSpan={stocks.length + 1} />
            <MetricRow 
              label="Current Price" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.currentPrice} formatValue={formatCurrency}
            />
            <MetricRow 
              label="Market Cap" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.marketCap} formatValue={formatLargeNumber}
            />
            <MetricRow 
              label="Beta (Volatility)" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.beta} formatValue={formatNumber} lowerIsBetter
            />

            {/* Valuation */}
            <SectionHeader title="Valuation" colSpan={stocks.length + 1} />
            <MetricRow
              label="P/E Ratio" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.peRatio} formatValue={formatNumber} lowerIsBetter validFilter={v => v > 0}
            />
            <MetricRow 
              label="PEG Ratio" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.pegRatio} formatValue={formatNumber} lowerIsBetter
            />
            <MetricRow 
              label="Price-to-Book" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.priceToBook} formatValue={formatNumber} lowerIsBetter
            />
            <MetricRow 
              label="Price-to-Sales" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.priceToSales} formatValue={formatNumber} lowerIsBetter
            />
            <MetricRow 
              label="Analyst Target" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.analystTargetPrice} formatValue={formatCurrency}
            />

            {/* Growth & Revenue */}
            <SectionHeader title="Growth & Revenue" colSpan={stocks.length + 1} />
            <MetricRow 
              label="Total Revenue" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.totalRevenue} formatValue={formatLargeNumber} higherIsBetter
            />
            <MetricRow 
              label="Revenue Growth (YoY)" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.revenueGrowthYoY} formatValue={formatPercent} higherIsBetter
            />
            <MetricRow 
              label="Net Income" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.netIncome} formatValue={formatLargeNumber} higherIsBetter
            />

            {/* Profitability */}
            <SectionHeader title="Profitability" colSpan={stocks.length + 1} />
            <MetricRow 
              label="Gross Margin" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.grossMargin} formatValue={formatPercent} higherIsBetter
            />
            <MetricRow 
              label="Operating Margin" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.operatingMargin} formatValue={formatPercent} higherIsBetter
            />
            <MetricRow 
              label="Net Margin" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.netMargin} formatValue={formatPercent} higherIsBetter
            />
            <MetricRow 
              label="ROE" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.returnOnEquity} formatValue={formatPercent} higherIsBetter
            />
            <MetricRow 
              label="Free Cash Flow" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.freeCashFlow} formatValue={formatLargeNumber} higherIsBetter
            />

            {/* Per Share & Income */}
            <SectionHeader title="Per Share & Income" colSpan={stocks.length + 1} />
            <MetricRow 
              label="EPS" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.earningsPerShare} formatValue={formatCurrency} higherIsBetter
            />
            <MetricRow 
              label="EPS Growth" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.epsGrowth} formatValue={formatPercent} higherIsBetter
            />
            <MetricRow 
              label="Dividend Yield" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.dividendYield} formatValue={formatPercent} higherIsBetter
            />

            {/* Balance Sheet */}
            <SectionHeader title="Balance Sheet" colSpan={stocks.length + 1} />
            <MetricRow 
              label="Debt-to-Equity" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.debtToEquity} formatValue={formatNumber} lowerIsBetter
            />
            <MetricRow 
              label="Current Ratio" stocks={stocks} loadingTickers={loadingTickers}
              getValue={s => s.currentRatio} formatValue={formatNumber} higherIsBetter
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}
