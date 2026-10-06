// Rule-based trend findings over SEC EDGAR multi-year statements + FMP cross-check. Moved from routes/stocks.ts.
import type { EdgarStatementHistoryRow, TickerFundamentalsRow } from "@workspace/db";

export interface EdgarFinding { text: string; tone: "positive" | "negative" | "neutral"; }

function cagr(first: number, last: number, years: number): number | null {
  if (first <= 0 || years <= 0) return null;
  return Math.pow(last / first, 1 / years) - 1;
}

export function computeEdgarFindings(
  rows: EdgarStatementHistoryRow[],
  fmpRow: TickerFundamentalsRow | null,
): EdgarFinding[] {
  const findings: EdgarFinding[] = [];
  // rows can carry 6 fiscal years per item (5 displayed + 1 extra as a YoY baseline for
  // the oldest displayed year — see fetchEdgarStatementHistory). Drop that extra oldest
  // year here so findings describe the same 5-year window the UI shows.
  const byItem = (lineItem: string) => {
    const arr = rows
      .filter(r => r.lineItem === lineItem)
      .map(r => ({ year: r.fiscalYear, value: Number(r.value) }))
      .sort((a, b) => a.year - b.year);
    return arr.length > 5 ? arr.slice(1) : arr;
  };

  const revenue = byItem("revenue");
  const netIncome = byItem("netIncome");
  const grossProfit = byItem("grossProfit");
  const operatingCF = byItem("operatingCashFlow");
  const capex = byItem("capex");
  const longTermDebt = byItem("longTermDebt");
  const equity = byItem("stockholdersEquity");

  if (revenue.length >= 2) {
    const c = cagr(revenue[0].value, revenue[revenue.length - 1].value, revenue.length - 1);
    if (c != null) {
      findings.push({
        text: `Revenue ${c >= 0 ? "grew" : "declined"} at a ${(c * 100).toFixed(1)}% annual rate over the last ${revenue.length} filed years (SEC 10-K).`,
        tone: c > 0.03 ? "positive" : c < -0.03 ? "negative" : "neutral",
      });
    }
  }

  if (grossProfit.length >= 2 && revenue.length >= 2) {
    const marginAt = (year: number) => {
      const gp = grossProfit.find(g => g.year === year)?.value;
      const rev = revenue.find(r => r.year === year)?.value;
      return gp != null && rev ? gp / rev : null;
    };
    const first = marginAt(grossProfit[0].year);
    const last = marginAt(grossProfit[grossProfit.length - 1].year);
    if (first != null && last != null) {
      const delta = last - first;
      findings.push({
        text: `Gross margin ${delta >= 0 ? "expanded" : "compressed"} from ${(first * 100).toFixed(1)}% to ${(last * 100).toFixed(1)}% over the filed history.`,
        tone: delta > 0.005 ? "positive" : delta < -0.005 ? "negative" : "neutral",
      });
    }
  }

  if (operatingCF.length > 0 && netIncome.length > 0) {
    const latestYear = Math.max(...operatingCF.map(o => o.year));
    const opCF = operatingCF.find(o => o.year === latestYear)?.value;
    const capexVal = Math.abs(capex.find(c => c.year === latestYear)?.value ?? 0);
    const ni = netIncome.find(n => n.year === latestYear)?.value;
    if (opCF != null && ni != null) {
      const fcf = opCF - capexVal;
      const gap = ni !== 0 ? (fcf - ni) / Math.abs(ni) : 0;
      if (gap < -0.25) {
        findings.push({
          text: `FY${latestYear} free cash flow ($${(fcf / 1e6).toFixed(0)}M) is well below reported net income ($${(ni / 1e6).toFixed(0)}M) — an earnings-quality flag worth digging into (accruals, working-capital swings, or capex timing).`,
          tone: "negative",
        });
      } else if (gap > 0.1) {
        findings.push({
          text: `FY${latestYear} free cash flow ($${(fcf / 1e6).toFixed(0)}M) comfortably exceeds net income ($${(ni / 1e6).toFixed(0)}M) — earnings are being backed by real cash generation.`,
          tone: "positive",
        });
      }
    }
  }

  if (longTermDebt.length >= 2 && equity.length >= 2) {
    const ratioAt = (year: number) => {
      const d = longTermDebt.find(x => x.year === year)?.value;
      const e = equity.find(x => x.year === year)?.value;
      return d != null && e ? d / e : null;
    };
    const first = ratioAt(longTermDebt[0].year);
    const last = ratioAt(longTermDebt[longTermDebt.length - 1].year);
    if (first != null && last != null) {
      const delta = last - first;
      if (Math.abs(delta) > 0.1) {
        findings.push({
          text: `Long-term debt / equity ${delta > 0 ? "rose" : "fell"} from ${first.toFixed(2)}x to ${last.toFixed(2)}x over the filed history.`,
          tone: delta > 0 ? "negative" : "positive",
        });
      }
    }
  }

  // Cross-check against the FMP-derived numbers already shown elsewhere in the app —
  // this is the actual "second layer of validation" against the existing pipeline.
  if (fmpRow && revenue.length > 0) {
    const fmpRevenue = fmpRow.totalRevenue != null ? Number(fmpRow.totalRevenue) : null;
    if (fmpRevenue && fmpRevenue > 0) {
      // FMP's figure can lag one fiscal year behind EDGAR's most recently filed 10-K (e.g.
      // MSFT's FY ends in June — EDGAR reflects the new FY within weeks of filing, but FMP's
      // annual revenue can still show the prior FY for a while). Compare against whichever of
      // the last two EDGAR years is the closer match so a one-year lag isn't misreported as a
      // genuine data-quality issue.
      const candidates = revenue.slice(-2);
      const best = candidates.reduce((a, b) =>
        Math.abs(a.value - fmpRevenue) <= Math.abs(b.value - fmpRevenue) ? a : b);
      const diff = Math.abs(best.value - fmpRevenue) / fmpRevenue;
      if (diff > 0.05) {
        findings.push({
          text: `Data discrepancy: SEC-filed FY${best.year} revenue ($${(best.value / 1e6).toFixed(0)}M) differs from the FMP-sourced figure shown on this page ($${(fmpRevenue / 1e6).toFixed(0)}M) by ${(diff * 100).toFixed(1)}% — worth checking which period each source is reporting.`,
          tone: "negative",
        });
      }
    }
  }

  return findings;
}

export function groupStatementRows(rows: EdgarStatementHistoryRow[]) {
  const group = (type: string) => {
    const byLineItem = new Map<string, { fiscalYear: number; value: number }[]>();
    for (const r of rows.filter(x => x.statementType === type)) {
      const arr = byLineItem.get(r.lineItem) ?? [];
      arr.push({ fiscalYear: r.fiscalYear, value: Number(r.value) });
      byLineItem.set(r.lineItem, arr);
    }
    return Object.fromEntries(
      [...byLineItem.entries()].map(([k, v]) => [k, v.sort((a, b) => b.fiscalYear - a.fiscalYear)]),
    );
  };
  return { income: group("income"), balance: group("balance"), cashflow: group("cashflow") };
}
