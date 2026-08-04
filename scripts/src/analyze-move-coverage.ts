/**
 * analyze-move-coverage.ts
 *
 * Extends analyze-news-triggers.ts: for every watchlist ticker, find ALL
 * daily excess moves (stock % change minus SPY % change, to strip out
 * macro) over the last ~45 trading days -- not just days that happened to
 * have a matched headline -- then check whether each big move is explained
 * by a structured trigger (earnings report date, analyst upgrade/downgrade)
 * already available from Yahoo. For moves NOT explained by either, print
 * the day's headlines so we can manually bucket the remaining causes
 * (product news, M&A/stake filings, litigation, guidance, sector
 * contagion, etc).
 *
 * Usage: pnpm --filter @workspace/api-server exec tsx ./src/scripts/analyze-move-coverage.ts
 * (run from artifacts/api-server so yahoo-finance2 resolves)
 */

import YahooFinanceClass from "yahoo-finance2";

const yahooFinance = new YahooFinanceClass();

const WATCHLIST = [
  "NVDA","INTC","MRVL","PLTR","HOOD","RDDT","AAPL","AMZN","GOOGL","TSLA","NOW",
  "BABA","SMCI","SNOW","AAOI","NFLX","NET","OPEN","ONDS","POET","SHOP","FSLY","RUM",
  "JOBY","ACHR","BB","IONQ","SOFI","TTD","RKLB","RDW",
];

const EXCESS_MOVE_THRESHOLD = 5; // percentage points -- bigger bar than last run, focused on the clearly-notable moves
const DAYS = 45;

interface DailyBar { date: string; close: number }

async function fetchDailyBars(ticker: string, days = DAYS): Promise<DailyBar[]> {
  const period2 = new Date();
  const period1 = new Date();
  period1.setDate(period1.getDate() - days);
  try {
    const rows = await yahooFinance.historical(ticker, { period1, period2, interval: "1d" }, { validateResult: false } as any);
    return rows.map((r: any) => ({ date: new Date(r.date).toISOString().slice(0, 10), close: r.close }));
  } catch (e) {
    console.error(`  [bars] ${ticker} failed: ${(e as Error).message}`);
    return [];
  }
}

function dailyMoves(bars: DailyBar[]): { date: string; pct: number }[] {
  const out: { date: string; pct: number }[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (prev) out.push({ date: bars[i].date, pct: ((cur - prev) / prev) * 100 });
  }
  return out;
}

async function fetchEarningsDates(ticker: string): Promise<Set<string>> {
  const dates = new Set<string>();
  try {
    const res: any = await yahooFinance.quoteSummary(ticker, { modules: ["earningsHistory"] } as any, { validateResult: false } as any);
    const hist = res?.earningsHistory?.history ?? [];
    for (const h of hist) {
      const d = h.quarter ?? h.epsActual?.fmt ? h.quarter : null;
      if (h.quarter) dates.add(new Date(h.quarter).toISOString().slice(0, 10));
    }
  } catch (e) {
    console.error(`  [earnings] ${ticker} failed: ${(e as Error).message}`);
  }
  return dates;
}

async function fetchAnalystActionDates(ticker: string): Promise<Set<string>> {
  const dates = new Set<string>();
  try {
    const res: any = await yahooFinance.quoteSummary(ticker, { modules: ["upgradeDowngradeHistory"] } as any, { validateResult: false } as any);
    const hist = res?.upgradeDowngradeHistory?.history ?? [];
    for (const h of hist) {
      if (h.epochGradeDate) dates.add(new Date(h.epochGradeDate).toISOString().slice(0, 10));
    }
  } catch (e) {
    console.error(`  [analyst] ${ticker} failed: ${(e as Error).message}`);
  }
  return dates;
}

function withinOneDay(dateStr: string, dateSet: Set<string>): boolean {
  const d = new Date(dateStr);
  for (const offset of [-1, 0, 1]) {
    const check = new Date(d);
    check.setDate(check.getDate() + offset);
    if (dateSet.has(check.toISOString().slice(0, 10))) return true;
  }
  return false;
}

async function main() {
  console.log(`Coverage test: excess move >= ${EXCESS_MOVE_THRESHOLD}pp vs SPY, ${DAYS} days, ${WATCHLIST.length} tickers\n`);

  const spyBars = await fetchDailyBars("SPY");
  const spyMoves = new Map(dailyMoves(spyBars).map((m) => [m.date, m.pct]));

  let totalBigMoves = 0;
  let explainedByEarnings = 0;
  let explainedByAnalyst = 0;
  let unexplained = 0;
  const unexplainedCases: { ticker: string; date: string; excess: number; headlines: string[] }[] = [];

  for (const ticker of WATCHLIST) {
    const bars = await fetchDailyBars(ticker);
    if (bars.length < 5) continue;
    const moves = dailyMoves(bars);

    const [earningsDates, analystDates] = await Promise.all([
      fetchEarningsDates(ticker),
      fetchAnalystActionDates(ticker),
    ]);

    let news: any[] = [];
    try {
      const res: any = await yahooFinance.search(ticker, { newsCount: 10, quotesCount: 0 } as any, { validateResult: false });
      news = res.news ?? [];
    } catch {
      /* ignore */
    }

    for (const m of moves) {
      const spyPct = spyMoves.get(m.date);
      if (spyPct === undefined) continue;
      const excess = m.pct - spyPct;
      if (Math.abs(excess) < EXCESS_MOVE_THRESHOLD) continue;

      totalBigMoves++;
      const hasEarnings = withinOneDay(m.date, earningsDates);
      const hasAnalyst = withinOneDay(m.date, analystDates);

      if (hasEarnings) explainedByEarnings++;
      else if (hasAnalyst) explainedByAnalyst++;
      else {
        unexplained++;
        const dayHeadlines = news
          .filter((n) => new Date(n.providerPublishTime).toISOString().slice(0, 10) === m.date)
          .map((n) => n.title);
        unexplainedCases.push({ ticker, date: m.date, excess, headlines: dayHeadlines });
      }
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`Total big excess moves (>= ${EXCESS_MOVE_THRESHOLD}pp): ${totalBigMoves}`);
  console.log(`  Explained by earnings date (±1 day): ${explainedByEarnings}`);
  console.log(`  Explained by analyst action (±1 day): ${explainedByAnalyst}`);
  console.log(`  Unexplained by either: ${unexplained}\n`);

  console.log(`=== Unexplained cases (need manual categorization from same-day headlines) ===\n`);
  for (const c of unexplainedCases) {
    console.log(`[${c.ticker}] ${c.date} excess=${c.excess.toFixed(1)}pp`);
    if (c.headlines.length === 0) {
      console.log(`   (no matched headline in top-10 search results for this ticker)`);
    } else {
      for (const h of c.headlines) console.log(`   - ${h}`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
