/**
 * analyze-news-triggers.ts
 *
 * One-off ad-hoc analysis (not wired into any pipeline). For each watchlist
 * ticker, pulls recent news headlines + the daily price move on the
 * headline's publish date, compares it to SPY's move that same day to
 * strip out macro-driven noise, and reports which headline keywords
 * co-occur with a large *excess* (stock-move minus SPY-move) move.
 *
 * Goal: empirically ground which keywords are worth coding as "significant
 * event" triggers for the scheduled bullet-regeneration job, instead of
 * guessing a keyword list.
 *
 * Usage: tsx scripts/src/analyze-news-triggers.ts
 */

import YahooFinanceClass from "yahoo-finance2";

const yahooFinance = new YahooFinanceClass();

const WATCHLIST = [
  "NVDA","INTC","MRVL","PLTR","HOOD","RDDT","AAPL","AMZN","GOOGL","TSLA","NOW",
  "BABA","SMCI","SNOW","AAOI","NFLX","NET","OPEN","ONDS","POET","SHOP","FSLY","RUM",
  "JOBY","ACHR","BB","IONQ","SOFI","TTD","RKLB","RDW",
];

const EXCESS_MOVE_THRESHOLD = 3; // percentage points, ticker move minus SPY move

interface DailyBar { date: string; close: number }
interface NewsHit { ticker: string; title: string; publishedAt: string; tickerMovePct: number | null; spyMovePct: number | null; excessMovePct: number | null }

async function fetchDailyBars(ticker: string, days = 30): Promise<DailyBar[]> {
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

function pctChangeOnDate(bars: DailyBar[], dateStr: string): number | null {
  const idx = bars.findIndex((b) => b.date === dateStr);
  if (idx <= 0) return null; // need a prior bar to diff against
  const prev = bars[idx - 1].close;
  const cur = bars[idx].close;
  if (!prev) return null;
  return ((cur - prev) / prev) * 100;
}

async function main() {
  console.log(`Analyzing news-vs-price-move for ${WATCHLIST.length} watchlist tickers...\n`);

  const spyBars = await fetchDailyBars("SPY", 45);
  const hits: NewsHit[] = [];

  for (const ticker of WATCHLIST) {
    let news: any[] = [];
    try {
      const res = await yahooFinance.search(ticker, { newsCount: 10, quotesCount: 0 } as any, { validateResult: false });
      news = (res as any).news ?? [];
    } catch (e) {
      console.error(`  [news] ${ticker} failed: ${(e as Error).message}`);
      continue;
    }
    if (news.length === 0) continue;

    const bars = await fetchDailyBars(ticker, 45);

    for (const n of news) {
      const publishedAt = new Date(n.providerPublishTime).toISOString();
      const dateStr = publishedAt.slice(0, 10);
      const tickerMovePct = pctChangeOnDate(bars, dateStr);
      const spyMovePct = pctChangeOnDate(spyBars, dateStr);
      const excessMovePct = tickerMovePct !== null && spyMovePct !== null ? tickerMovePct - spyMovePct : null;
      hits.push({ ticker, title: n.title, publishedAt, tickerMovePct, spyMovePct, excessMovePct });
    }

    // be polite to the upstream API
    await new Promise((r) => setTimeout(r, 250));
  }

  console.log(`\nCollected ${hits.length} headlines with price context.\n`);

  const significant = hits
    .filter((h) => h.excessMovePct !== null && Math.abs(h.excessMovePct) >= EXCESS_MOVE_THRESHOLD)
    .sort((a, b) => Math.abs(b.excessMovePct!) - Math.abs(a.excessMovePct!));

  console.log(`=== Headlines co-occurring with excess move >= ${EXCESS_MOVE_THRESHOLD}pp (vs SPY) ===\n`);
  for (const h of significant) {
    console.log(`[${h.ticker}] excess=${h.excessMovePct!.toFixed(1)}pp (stock=${h.tickerMovePct!.toFixed(1)}%, spy=${h.spyMovePct!.toFixed(1)}%) ${h.publishedAt.slice(0,10)}`);
    console.log(`   "${h.title}"`);
  }

  // Keyword frequency: significant vs non-significant headlines
  const STOPWORDS = new Set(["the","a","an","to","of","for","in","on","and","is","are","its","will","with","by","at","as","after","new"]);
  function tokenize(title: string): string[] {
    return title.toLowerCase().replace(/[^a-z0-9%$.\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
  }

  const sigWords = new Map<string, number>();
  const nonSigWords = new Map<string, number>();
  for (const h of hits) {
    const isSig = h.excessMovePct !== null && Math.abs(h.excessMovePct) >= EXCESS_MOVE_THRESHOLD;
    const target = isSig ? sigWords : nonSigWords;
    for (const w of tokenize(h.title)) {
      target.set(w, (target.get(w) ?? 0) + 1);
    }
  }

  const sigTotal = [...sigWords.values()].reduce((a, b) => a + b, 0) || 1;
  const nonSigTotal = [...nonSigWords.values()].reduce((a, b) => a + b, 0) || 1;

  const ranked = [...sigWords.entries()]
    .filter(([, count]) => count >= 2) // need at least 2 occurrences to trust the signal
    .map(([word, count]) => {
      const sigRate = count / sigTotal;
      const nonSigRate = (nonSigWords.get(word) ?? 0) / nonSigTotal;
      const lift = sigRate / (nonSigRate || 1 / nonSigTotal);
      return { word, sigCount: count, nonSigCount: nonSigWords.get(word) ?? 0, lift };
    })
    .sort((a, b) => b.lift - a.lift);

  console.log(`\n=== Candidate trigger keywords (ranked by lift toward excess-move headlines) ===\n`);
  for (const r of ranked.slice(0, 40)) {
    console.log(`${r.word.padEnd(20)} sig=${r.sigCount}  non-sig=${r.nonSigCount}  lift=${r.lift.toFixed(1)}x`);
  }

  console.log(`\nTotal headlines: ${hits.length} | Significant (>= ${EXCESS_MOVE_THRESHOLD}pp excess): ${significant.length}`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
