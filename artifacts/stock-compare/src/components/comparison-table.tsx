import { StockMetrics } from "@workspace/api-client-react";
import { formatCurrency, formatPercent, formatNumber, formatLargeNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface ComparisonTableProps {
  stock1: StockMetrics;
  stock2: StockMetrics;
}

interface MetricRowProps {
  label: string;
  val1: React.ReactNode;
  val2: React.ReactNode;
  highlightBetter?: "higher" | "lower";
  num1?: number | null;
  num2?: number | null;
}

function MetricRow({ label, val1, val2, highlightBetter, num1, num2 }: MetricRowProps) {
  let w1 = false;
  let w2 = false;

  if (highlightBetter && num1 != null && num2 != null) {
    if (highlightBetter === "higher") {
      w1 = num1 > num2;
      w2 = num2 > num1;
    } else {
      w1 = num1 < num2;
      w2 = num2 < num1;
    }
  }

  return (
    <tr className="border-b border-border/50 hover:bg-secondary/10 transition-colors group">
      <td className="p-3 text-sm font-medium text-muted-foreground group-hover:text-foreground transition-colors w-1/3">
        {label}
      </td>
      <td className={cn(
        "p-3 text-right font-mono text-sm w-1/3",
        w1 ? "text-primary font-bold bg-primary/5" : "text-foreground"
      )}>
        {val1}
      </td>
      <td className={cn(
        "p-3 text-right font-mono text-sm w-1/3",
        w2 ? "text-primary font-bold bg-primary/5" : "text-foreground"
      )}>
        {val2}
      </td>
    </tr>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <tr className="bg-secondary/30">
      <td colSpan={3} className="p-3 text-xs font-bold uppercase tracking-wider text-foreground">
        {title}
      </td>
    </tr>
  );
}

export function ComparisonTable({ stock1, stock2 }: ComparisonTableProps) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden shadow-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="border-b border-border bg-card">
              <th className="p-4 font-semibold text-muted-foreground w-1/3">Metric</th>
              <th className="p-4 font-bold text-xl text-right w-1/3">
                <div className="flex items-center justify-end gap-2">
                  {stock1.logoUrl && <img src={stock1.logoUrl} alt="" className="w-6 h-6 rounded bg-white" />}
                  {stock1.ticker}
                </div>
              </th>
              <th className="p-4 font-bold text-xl text-right w-1/3">
                <div className="flex items-center justify-end gap-2">
                  {stock2.logoUrl && <img src={stock2.logoUrl} alt="" className="w-6 h-6 rounded bg-white" />}
                  {stock2.ticker}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {/* Overview */}
            <SectionHeader title="Overview" />
            <MetricRow label="Company Name" val1={stock1.companyName} val2={stock2.companyName} />
            <MetricRow label="Sector" val1={stock1.sector || "-"} val2={stock2.sector || "-"} />
            <MetricRow label="Industry" val1={stock1.industry || "-"} val2={stock2.industry || "-"} />
            <MetricRow label="Stock Type" val1={stock1.stockType || "-"} val2={stock2.stockType || "-"} />
            <MetricRow 
              label="Current Price" 
              val1={formatCurrency(stock1.currentPrice)} 
              val2={formatCurrency(stock2.currentPrice)} 
            />
            <MetricRow 
              label="Market Cap" 
              val1={formatLargeNumber(stock1.marketCap)} 
              val2={formatLargeNumber(stock2.marketCap)} 
              highlightBetter="higher" num1={stock1.marketCap} num2={stock2.marketCap}
            />
            <MetricRow 
              label="52-Week Range" 
              val1={`${formatCurrency(stock1.fiftyTwoWeekLow)} - ${formatCurrency(stock1.fiftyTwoWeekHigh)}`} 
              val2={`${formatCurrency(stock2.fiftyTwoWeekLow)} - ${formatCurrency(stock2.fiftyTwoWeekHigh)}`} 
            />
            <MetricRow 
              label="Beta (Volatility)" 
              val1={formatNumber(stock1.beta)} 
              val2={formatNumber(stock2.beta)} 
              highlightBetter="lower" num1={stock1.beta} num2={stock2.beta}
            />

            {/* Valuation */}
            <SectionHeader title="Valuation" />
            <MetricRow 
              label="P/E Ratio" 
              val1={formatNumber(stock1.peRatio)} 
              val2={formatNumber(stock2.peRatio)} 
              highlightBetter="lower" num1={stock1.peRatio} num2={stock2.peRatio}
            />
            <MetricRow 
              label="PEG Ratio" 
              val1={formatNumber(stock1.pegRatio)} 
              val2={formatNumber(stock2.pegRatio)} 
              highlightBetter="lower" num1={stock1.pegRatio} num2={stock2.pegRatio}
            />
            <MetricRow 
              label="Price-to-Book" 
              val1={formatNumber(stock1.priceToBook)} 
              val2={formatNumber(stock2.priceToBook)} 
              highlightBetter="lower" num1={stock1.priceToBook} num2={stock2.priceToBook}
            />
            <MetricRow 
              label="Price-to-Sales" 
              val1={formatNumber(stock1.priceToSales)} 
              val2={formatNumber(stock2.priceToSales)} 
              highlightBetter="lower" num1={stock1.priceToSales} num2={stock2.priceToSales}
            />
            <MetricRow 
              label="Fair Value Est." 
              val1={formatCurrency(stock1.fairValueEstimate)} 
              val2={formatCurrency(stock2.fairValueEstimate)} 
            />
            <MetricRow 
              label="Analyst Target" 
              val1={formatCurrency(stock1.analystTargetPrice)} 
              val2={formatCurrency(stock2.analystTargetPrice)} 
            />

            {/* Growth & Revenue */}
            <SectionHeader title="Growth & Revenue" />
            <MetricRow 
              label="Total Revenue" 
              val1={formatLargeNumber(stock1.totalRevenue)} 
              val2={formatLargeNumber(stock2.totalRevenue)} 
              highlightBetter="higher" num1={stock1.totalRevenue} num2={stock2.totalRevenue}
            />
            <MetricRow 
              label="Revenue Growth (YoY)" 
              val1={formatPercent(stock1.revenueGrowthYoY)} 
              val2={formatPercent(stock2.revenueGrowthYoY)} 
              highlightBetter="higher" num1={stock1.revenueGrowthYoY} num2={stock2.revenueGrowthYoY}
            />
            <MetricRow 
              label="Projected Rev Growth" 
              val1={formatPercent(stock1.revenueGrowthProjected)} 
              val2={formatPercent(stock2.revenueGrowthProjected)} 
              highlightBetter="higher" num1={stock1.revenueGrowthProjected} num2={stock2.revenueGrowthProjected}
            />
            <MetricRow 
              label="Net Income" 
              val1={formatLargeNumber(stock1.netIncome)} 
              val2={formatLargeNumber(stock2.netIncome)} 
              highlightBetter="higher" num1={stock1.netIncome} num2={stock2.netIncome}
            />
            <MetricRow 
              label="EBITDA" 
              val1={formatLargeNumber(stock1.ebitda)} 
              val2={formatLargeNumber(stock2.ebitda)} 
              highlightBetter="higher" num1={stock1.ebitda} num2={stock2.ebitda}
            />

            {/* Profitability */}
            <SectionHeader title="Profitability" />
            <MetricRow 
              label="Gross Margin" 
              val1={formatPercent(stock1.grossMargin)} 
              val2={formatPercent(stock2.grossMargin)} 
              highlightBetter="higher" num1={stock1.grossMargin} num2={stock2.grossMargin}
            />
            <MetricRow 
              label="Operating Margin" 
              val1={formatPercent(stock1.operatingMargin)} 
              val2={formatPercent(stock2.operatingMargin)} 
              highlightBetter="higher" num1={stock1.operatingMargin} num2={stock2.operatingMargin}
            />
            <MetricRow 
              label="Net Margin" 
              val1={formatPercent(stock1.netMargin)} 
              val2={formatPercent(stock2.netMargin)} 
              highlightBetter="higher" num1={stock1.netMargin} num2={stock2.netMargin}
            />
            <MetricRow 
              label="Return on Equity (ROE)" 
              val1={formatPercent(stock1.returnOnEquity)} 
              val2={formatPercent(stock2.returnOnEquity)} 
              highlightBetter="higher" num1={stock1.returnOnEquity} num2={stock2.returnOnEquity}
            />
            <MetricRow 
              label="Return on Assets (ROA)" 
              val1={formatPercent(stock1.returnOnAssets)} 
              val2={formatPercent(stock2.returnOnAssets)} 
              highlightBetter="higher" num1={stock1.returnOnAssets} num2={stock2.returnOnAssets}
            />
            <MetricRow 
              label="Free Cash Flow" 
              val1={formatLargeNumber(stock1.freeCashFlow)} 
              val2={formatLargeNumber(stock2.freeCashFlow)} 
              highlightBetter="higher" num1={stock1.freeCashFlow} num2={stock2.freeCashFlow}
            />

            {/* Per Share & Income */}
            <SectionHeader title="Per Share & Income" />
            <MetricRow 
              label="Earnings Per Share (EPS)" 
              val1={formatCurrency(stock1.earningsPerShare)} 
              val2={formatCurrency(stock2.earningsPerShare)} 
              highlightBetter="higher" num1={stock1.earningsPerShare} num2={stock2.earningsPerShare}
            />
            <MetricRow 
              label="EPS Growth" 
              val1={formatPercent(stock1.epsGrowth)} 
              val2={formatPercent(stock2.epsGrowth)} 
              highlightBetter="higher" num1={stock1.epsGrowth} num2={stock2.epsGrowth}
            />
            <MetricRow 
              label="Dividend Yield" 
              val1={formatPercent(stock1.dividendYield)} 
              val2={formatPercent(stock2.dividendYield)} 
              highlightBetter="higher" num1={stock1.dividendYield} num2={stock2.dividendYield}
            />

            {/* Balance Sheet */}
            <SectionHeader title="Balance Sheet" />
            <MetricRow 
              label="Debt-to-Equity" 
              val1={formatNumber(stock1.debtToEquity)} 
              val2={formatNumber(stock2.debtToEquity)} 
              highlightBetter="lower" num1={stock1.debtToEquity} num2={stock2.debtToEquity}
            />
            <MetricRow 
              label="Leverage Ratio" 
              val1={formatNumber(stock1.leverageRatio)} 
              val2={formatNumber(stock2.leverageRatio)} 
              highlightBetter="lower" num1={stock1.leverageRatio} num2={stock2.leverageRatio}
            />
            <MetricRow 
              label="Current Ratio" 
              val1={formatNumber(stock1.currentRatio)} 
              val2={formatNumber(stock2.currentRatio)} 
              highlightBetter="higher" num1={stock1.currentRatio} num2={stock2.currentRatio}
            />
          </tbody>
        </table>
      </div>
    </div>
  );
}
