import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, LineChart, Line, LabelList, XAxis, YAxis, CartesianGrid, Tooltip,
} from "recharts";
import { Loader2, AlertCircle, TrendingUp, TrendingDown, Minus, ArrowUp, ArrowDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatLargeNumber, formatCompactCurrency } from "@/lib/format";

interface StatementPoint {
  fiscalYear: number;
  value: number;
}

interface EdgarStatementsPayload {
  available: boolean;
  income: Record<string, StatementPoint[]>;
  balance: Record<string, StatementPoint[]>;
  cashflow: Record<string, StatementPoint[]>;
  findings: { text: string; tone: "positive" | "negative" | "neutral" }[];
  asOf: string | null;
  fiscalYearEnd: string | null; // "MM-DD", e.g. "02-28" for BlackBerry
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatFiscalYearEnd(mmdd: string): string {
  const [mm, dd] = mmdd.split("-").map(Number);
  return `${MONTH_NAMES[mm - 1]} ${dd}`;
}

function useEdgarStatements(ticker: string) {
  return useQuery<EdgarStatementsPayload, Error>({
    queryKey: ["edgar-statements", ticker],
    queryFn: async () => {
      const res = await fetch(`/api/stocks/edgar-statements/${encodeURIComponent(ticker)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    staleTime: 60 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    retry: 1,
  });
}

interface CompetitorRanked {
  rank: number;
  ticker: string;
  combinedScore: number | null;
  techScore: number | null;
  fundScore: number | null;
  pendingBackfill: boolean;
}

interface CompetitorsResponse {
  ticker: string;
  groupName: string | null;
  sector: string | null;
  ranked: CompetitorRanked[];
}

function useCompetitors(ticker: string) {
  return useQuery<CompetitorsResponse>({
    queryKey: ["stocks", "competitors", ticker],
    queryFn: async () => {
      const res = await fetch(`/api/stocks/competitors/${encodeURIComponent(ticker)}`);
      if (!res.ok) throw new Error(`Failed to fetch competitors: ${res.status}`);
      return res.json();
    },
    enabled: !!ticker,
    staleTime: 5 * 60 * 1000,
  });
}

const LINE_ITEM_LABELS: Record<string, string> = {
  revenue: "Revenue",
  costOfRevenue: "Cost of Revenue",
  grossProfit: "Gross Profit",
  operatingIncome: "Operating Income",
  netIncome: "Net Income",
  epsDiluted: "EPS (Diluted)",
  totalAssets: "Total Assets",
  currentAssets: "Current Assets",
  totalLiabilities: "Total Liabilities",
  currentLiabilities: "Current Liabilities",
  stockholdersEquity: "Stockholders' Equity",
  longTermDebt: "Long-Term Debt",
  cashAndEquivalents: "Cash & Equivalents",
  operatingCashFlow: "Operating Cash Flow",
  investingCashFlow: "Investing Cash Flow",
  financingCashFlow: "Financing Cash Flow",
  capex: "Capital Expenditures",
};

// Which direction of YoY change reads as "good" for each line item. Some of these
// (e.g. rising capex can be growth investment, not a red flag) are context-dependent —
// picked the conventional reading for consistency rather than leaving them uncolored.
const GOOD_DIRECTION: Record<string, "up" | "down"> = {
  revenue: "up",
  grossProfit: "up",
  operatingIncome: "up",
  netIncome: "up",
  epsDiluted: "up",
  totalAssets: "up",
  stockholdersEquity: "up",
  cashAndEquivalents: "up",
  operatingCashFlow: "up",
  investingCashFlow: "up",
  financingCashFlow: "up",
  currentAssets: "up",
  totalLiabilities: "down",
  currentLiabilities: "down",
  longTermDebt: "down",
  costOfRevenue: "down",
  capex: "down",
};

const STATEMENT_ROW_ORDER: Record<"income" | "balance" | "cashflow", string[]> = {
  income: ["revenue", "costOfRevenue", "grossProfit", "operatingIncome", "netIncome", "epsDiluted"],
  balance: ["totalAssets", "currentAssets", "totalLiabilities", "currentLiabilities", "stockholdersEquity", "longTermDebt", "cashAndEquivalents"],
  cashflow: ["operatingCashFlow", "investingCashFlow", "financingCashFlow", "capex"],
};

/** Green/red intent for a YoY change on a given line item — null when direction is ambiguous (no coloring). */
function trendIntent(lineItem: string, pctChange: number): "good" | "bad" | null {
  const dir = GOOD_DIRECTION[lineItem];
  if (!dir || Math.abs(pctChange) < 0.01) return null;
  const rose = pctChange > 0;
  if (dir === "up") return rose ? "good" : "bad";
  return rose ? "bad" : "good";
}

function StatementTable({
  title, data, statementType,
}: { title: string; data: Record<string, StatementPoint[]>; statementType: "income" | "balance" | "cashflow" }) {
  const rows = STATEMENT_ROW_ORDER[statementType].filter(k => data[k]?.length);
  if (rows.length === 0) return null;

  // allYears can include one extra (oldest) year beyond what's displayed — fetched only as
  // a YoY baseline for the oldest displayed year (see fetchEdgarStatementHistory). Show at
  // most 5 columns; prevYear lookups below still reach into that hidden extra year.
  const allYears = [...new Set(rows.flatMap(k => data[k].map(p => p.fiscalYear)))].sort((a, b) => b - a);
  const years = allYears.slice(0, 5);

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <div className="px-3 py-2 bg-teal-500/10 border-b border-teal-500/20 text-xs font-bold tracking-wide text-teal-300">
        {title}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border/50 bg-secondary/30">
              <th className="text-left px-3 py-1.5 font-semibold text-foreground/70">Line Item</th>
              {years.map(y => (
                <th key={y} className="text-right px-3 py-1.5 font-semibold text-foreground/70 font-mono">FY{y}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(k => (
              <tr key={k} className="border-b border-border/30 last:border-0">
                <td className="px-3 py-1.5 text-foreground font-medium">{LINE_ITEM_LABELS[k] ?? k}</td>
                {years.map((y, i) => {
                  const point = data[k].find(p => p.fiscalYear === y);
                  const prevYear = allYears[i + 1];
                  const prevPoint = prevYear != null ? data[k].find(p => p.fiscalYear === prevYear) : undefined;
                  const pctChange = point && prevPoint && prevPoint.value !== 0
                    ? (point.value - prevPoint.value) / Math.abs(prevPoint.value)
                    : null;
                  // Profit ↔ loss: a % off the old base is meaningless (FY21 HOOD showed ↓52771%); say the flip instead.
                  const signFlip = point != null && prevPoint != null && point.value * prevPoint.value < 0;
                  const intent = pctChange != null ? trendIntent(k, pctChange) : null;
                  return (
                    <td
                      key={y}
                      className={cn(
                        "text-right px-3 py-1.5 font-mono tabular-nums",
                        intent === "good" && "bg-green-500/[0.07]",
                        intent === "bad" && "bg-red-500/[0.07]",
                      )}
                    >
                      <div className="flex items-baseline justify-end gap-1.5">
                        {pctChange != null && (
                          <span className={cn(
                            "flex items-center text-[10px] font-bold",
                            intent === "good" ? "text-green-400" : intent === "bad" ? "text-red-400" : "text-foreground/50",
                          )}>
                            {pctChange >= 0 ? <ArrowUp className="w-2.5 h-2.5" /> : <ArrowDown className="w-2.5 h-2.5" />}
                            {signFlip ? (/income|eps/i.test(k) ? (point!.value < 0 ? "to loss" : "to profit") : (point!.value < 0 ? "to neg" : "to pos")) : `${Math.abs(pctChange * 100).toFixed(0)}%`}
                          </span>
                        )}
                        <span className="text-foreground font-semibold">{point ? formatLargeNumber(point.value) : "—"}</span>
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FindingIcon({ tone }: { tone: "positive" | "negative" | "neutral" }) {
  if (tone === "positive") return <TrendingUp className="w-3.5 h-3.5 text-green-400 shrink-0 mt-0.5" />;
  if (tone === "negative") return <TrendingDown className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />;
  return <Minus className="w-3.5 h-3.5 text-foreground/50 shrink-0 mt-0.5" />;
}

function scoreColor(score: number | null): string {
  if (score == null) return "text-foreground/50 border-border bg-secondary";
  if (score >= 70) return "text-green-400 border-green-500/30 bg-green-500/10";
  if (score >= 40) return "text-yellow-400 border-yellow-500/30 bg-yellow-500/10";
  return "text-red-400 border-red-500/30 bg-red-500/10";
}

/** Compact sector-peer strip for quick relative context while reading the statements below. */
function SectorPeersStrip({ ticker }: { ticker: string }) {
  const { data, isLoading } = useCompetitors(ticker);
  const peers = (data?.ranked ?? []).filter(p => p.ticker !== ticker).slice(0, 6);

  if (isLoading) {
    return <div className="text-xs text-amber-100 animate-pulse">Loading sector peers…</div>;
  }
  if (peers.length === 0) return null;

  return (
    <div className="rounded-lg border border-border/60 p-2.5 space-y-1.5">
      <div className="text-[10px] font-bold uppercase tracking-wider text-teal-300">
        Sector Peers{data?.groupName ? ` — ${data.groupName}` : ""}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {peers.map(p => (
          <span
            key={p.ticker}
            className={cn("flex items-center gap-1 text-[11px] font-bold px-2 py-1 rounded border", scoreColor(p.combinedScore))}
          >
            {p.ticker}
            <span className="font-mono opacity-80">{p.combinedScore != null ? p.combinedScore.toFixed(0) : "—"}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const REVENUE_LINE_COLOR = "#5eead4"; // teal-300, matches this section's accent color
const GROWTH_UP_COLOR = "#34d399";
const GROWTH_DOWN_COLOR = "#f87171";
const GROWTH_NEUTRAL_COLOR = "#52525b";

/** Single revenue line; each dot is labeled with its $ value and YoY % change directly above it. */
function RevenueTrendChart({ points }: { points: StatementPoint[] }) {
  // points can include one extra (oldest) year beyond what's displayed — fetched only as a
  // YoY baseline for the oldest displayed year (see fetchEdgarStatementHistory). Compute %
  // change against it, then drop it so the chart shows the same 5 years as the table above.
  const sorted = [...points].sort((a, b) => a.fiscalYear - b.fiscalYear);
  const withPct = sorted.map((p, i) => {
    const prev = sorted[i - 1];
    const pctChange = prev && prev.value !== 0 ? ((p.value - prev.value) / Math.abs(prev.value)) * 100 : null;
    return { year: `FY${p.fiscalYear}`, revenue: p.value, pctChange };
  });
  const chartData = withPct.length > 5 ? withPct.slice(1) : withPct;

  if (chartData.length === 0) return null;

  const renderDotLabel = (props: any) => {
    const { x, y, index } = props;
    const d = chartData[index];
    if (!d) return null;
    const pctText = d.pctChange == null ? null : `${d.pctChange >= 0 ? "+" : ""}${d.pctChange.toFixed(1)}%`;
    const pctColor = d.pctChange == null ? GROWTH_NEUTRAL_COLOR : d.pctChange >= 0 ? GROWTH_UP_COLOR : GROWTH_DOWN_COLOR;
    return (
      <g>
        <text x={x} y={y - 22} textAnchor="middle" fontSize={11} fontWeight={600} fill="#e5e7eb">
          {formatLargeNumber(d.revenue)}
        </text>
        {pctText && (
          <text x={x} y={y - 10} textAnchor="middle" fontSize={10} fontWeight={700} fill={pctColor}>
            {pctText}
          </text>
        )}
      </g>
    );
  };

  return (
    <div className="rounded-lg border border-border/60 p-3 space-y-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-teal-300">
        Revenue Trend — {chartData.length}-Year
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={chartData} margin={{ top: 36, right: 20, left: -8, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
          <XAxis dataKey="year" tick={{ fontSize: 10, fill: "#cbd5e1" }} />
          <YAxis tick={{ fontSize: 10, fill: "#cbd5e1" }} tickFormatter={(v: number) => formatCompactCurrency(v)} />
          <Tooltip
            contentStyle={{ background: "#111", border: "1px solid #333", fontSize: 11 }}
            formatter={(v: unknown, _name: string, item: any) => {
              const pct = item?.payload?.pctChange;
              const pctText = pct == null ? "n/a" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% YoY`;
              return [`${formatLargeNumber(v as number)} (${pctText})`, "Revenue"];
            }}
          />
          <Line type="monotone" dataKey="revenue" name="Revenue" stroke={REVENUE_LINE_COLOR} strokeWidth={2} dot={{ r: 4, fill: REVENUE_LINE_COLOR }} activeDot={{ r: 6 }}>
            <LabelList dataKey="revenue" content={renderDotLabel} />
          </Line>
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

type AccountingSubTab = "summary" | "income" | "balance" | "cashflow";

const ACCOUNTING_SUB_TABS: { id: AccountingSubTab; label: string }[] = [
  { id: "summary", label: "Summary" },
  { id: "income", label: "Income Statement" },
  { id: "balance", label: "Balance Sheet" },
  { id: "cashflow", label: "Cash Flow" },
];

export function AccountingStatementsSection({ ticker }: { ticker: string }) {
  const { data, isLoading, error } = useEdgarStatements(ticker);
  const [subTab, setSubTab] = useState<AccountingSubTab>("summary");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 text-foreground/70 py-10 text-sm">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading SEC filings…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg p-3 text-xs">
        <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        {error.message}
      </div>
    );
  }

  if (!data?.available) {
    return (
      <div className="text-center text-foreground/70 text-sm py-10">
        No SEC EDGAR filings found for {ticker}.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-foreground/50 leading-snug">
        SEC EDGAR 10-K (annual)
        {data.asOf && <> · filed {data.asOf}</>}
        {data.fiscalYearEnd && data.fiscalYearEnd !== "12-31" && (
          <> · FY ends {formatFiscalYearEnd(data.fiscalYearEnd)}</>
        )}
      </div>

      <div className="inline-flex rounded border border-teal-500/20 overflow-hidden text-[11px] font-semibold">
        {ACCOUNTING_SUB_TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSubTab(t.id)}
            className={cn(
              "px-2.5 py-1.5 transition-colors",
              subTab === t.id ? "bg-teal-500 text-black" : "bg-secondary/30 text-amber-100 hover:text-teal-300",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === "summary" && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start">
          <SectorPeersStrip ticker={ticker} />
          {data.findings.length > 0 && (
            <div className="space-y-1.5">
              {data.findings.map((f, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex gap-2 text-[12px] leading-relaxed rounded-md px-2.5 py-1.5 border",
                    f.tone === "positive" && "bg-green-500/[0.06] border-green-500/20 text-green-100",
                    f.tone === "negative" && "bg-red-500/[0.06] border-red-500/20 text-red-100",
                    f.tone === "neutral" && "bg-secondary/30 border-border/40 text-foreground/80",
                  )}
                >
                  <FindingIcon tone={f.tone} />
                  {f.text}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {subTab === "income" && (
        <div className="space-y-3">
          <StatementTable title="Income Statement" data={data.income} statementType="income" />
          <RevenueTrendChart points={data.income.revenue ?? []} />
        </div>
      )}
      {subTab === "balance" && <StatementTable title="Balance Sheet" data={data.balance} statementType="balance" />}
      {subTab === "cashflow" && <StatementTable title="Cash Flow Statement" data={data.cashflow} statementType="cashflow" />}
    </div>
  );
}
