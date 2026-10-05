import YahooFinanceClass from "yahoo-finance2"
import { inArray } from "drizzle-orm"
import { db, earningsCalendar, type PortfolioOrder, type PortfolioTransaction } from "@workspace/db"

const yahooFinance = new YahooFinanceClass()

/**
 * Does selling premium in a higher-volatility regime actually pay off for
 * THIS account's actual trades, or is that just textbook theory? True
 * historical implied-vol surfaces aren't available for these small/mid-cap
 * names without a paid data source, so this uses trailing 20-day REALIZED
 * volatility of the underlying as of each trade's open date as the vol-
 * regime proxy (a standard substitute when true IV history isn't available —
 * IV and realized vol are correlated, and this account's whole edge thesis is
 * "high-IV small caps," which realized vol approximates well enough to test).
 *
 * Outcome metric: for each short option sold, did the underlying close
 * OTM at expiration (full premium kept) or ITM (assignment/loss risk)? This
 * is a priced-based, objectively checkable outcome — no need to reconcile
 * against the exact realized-dollar P&L ledger, which can't be reliably
 * matched back to a specific opening order (see realized-pnl.ts's own
 * preference for Robinhood's own realized_close data over FIFO reconstruction
 * for that reason). Only grades CLOSED/expired contracts with price history
 * available; covered calls assigned ITM aren't a "loss" in the P&L sense
 * (often a planned exit at a gain) — this measures assignment-risk exposure,
 * not profitability, and that distinction should be surfaced in the UI.
 */

export interface GradedTrade {
  symbol: string
  optionSide: "call" | "put"
  strike: number
  openedAt: string
  expiration: string
  premium: number
  qty: number
  trailingVol20dAnnualizedPct: number
  underlyingAtExpiry: number
  keptFullPremium: boolean // underlying stayed OTM through expiration
  // Assignment-risk alert backtest: a moneyness-based proxy for the live
  // alert's "delta > 0.75" rule (true historical delta needs historical IV,
  // which isn't available — see module docstring). Checked at the MIDPOINT of
  // each trade's own holding period (not a fixed days-out like 14, which
  // doesn't exist within most of this account's trades — the majority are
  // 2-9 DTE weeklies, shorter than a 14-day lookback) — within
  // ASSIGNMENT_RISK_BAND_PCT (2%) of strike or already past it, tuned via
  // moneynessBandSweep below.
  underlyingAtMidHold: number | null
  flaggedAtRiskMidHold: boolean | null
  // Earnings-risk flag backtest: did the underlying have an earnings report
  // scheduled between this trade's open and its expiration? (IV crush risk —
  // the premium-selling thesis's own stated biggest hazard.)
  earningsInWindow: boolean
  // For short calls only: was ≥100×qty shares of the underlying actually held
  // (per the equity transaction ledger) as of this trade's open date? An ITM
  // assignment on a COVERED call is very often a planned, profitable exit
  // (premium + selling stock at the strike), not a loss — conflating it with
  // naked-call assignment risk (the same "ITM = bad" framing used for puts,
  // where assignment really is undesired) understated how much of the
  // call-side "risk" is actually normal wheel behavior. null for puts.
  isCoveredCall: boolean | null
}

export interface IvRankBacktestResult {
  buckets: Array<{
    bucket: "Low" | "Mid" | "High"
    count: number
    keptFullPremiumPct: number
    avgPremiumPerContract: number
    avgTrailingVol20dAnnualizedPct: number
  }>
  trades: GradedTrade[]
  totalEligible: number
  graded: number
  tickersWithNoPriceHistory: string[]
  // Does the live assignment-risk alert's rule actually predict real outcomes?
  // Checked against the same graded trades above, using the midpoint-of-hold
  // moneyness proxy (see GradedTrade.flaggedAtRiskMidHold).
  assignmentRiskCheckpoint: {
    checkedCount: number // trades with a valid midpoint price point
    flaggedCount: number
    flaggedWentItmPct: number // of flagged trades, % that ended up ITM at expiry
    unflaggedCount: number
    unflaggedWentItmPct: number // of unflagged trades, % that still ended up ITM (false negatives)
  }
  // Does the earnings-risk flag's premise hold for this account's own trades?
  // Compares the "kept full premium" rate for trades whose expiration spanned
  // an earnings report vs. those that didn't.
  earningsRiskCheck: {
    inWindowCount: number
    inWindowKeptFullPremiumPct: number
    outsideWindowCount: number
    outsideWindowKeptFullPremiumPct: number
  }
  // Is the assignment-risk alert's band width (2% moneyness, proxying the
  // live "delta > 0.75" rule) actually the best choice, or just a guess that
  // happened to show a real signal? Recomputes the same flag at several band
  // widths against
  // the same trades — a narrower band = a stricter/higher delta-equivalent bar
  // (fewer flags, each more certain); wider = looser (more flags, more false
  // positives). Lets the live alert's threshold be picked from evidence instead
  // of left at the first value tried.
  moneynessBandSweep: Array<{
    bandPct: number
    flaggedCount: number
    flaggedWentItmPct: number
    unflaggedWentItmPct: number
    separation: number // flaggedWentItmPct - unflaggedWentItmPct — bigger is a cleaner signal
  }>
  // Corrects the "ITM = bad" framing above for calls specifically: how much of
  // the short-call ITM rate is covered (likely a planned, fine exit) vs naked
  // or unknown-coverage (where ITM genuinely is a risk, same as for puts).
  coveredCallCheck: {
    totalCallTrades: number
    itmCallTrades: number
    coveredItmCount: number // of the ITM calls, how many were covered when opened
    nakedOrUnknownItmCount: number
  }
}

type DailyClose = { date: string; close: number }

async function fetchDailyCloseSeries(ticker: string, from: Date, to: Date): Promise<DailyClose[]> {
  const result = await yahooFinance.chart(ticker.toUpperCase(), {
    period1: from,
    period2: to,
    interval: "1d" as any,
  })
  const quotes = (result?.quotes ?? []).filter((q: any) => q.close != null)
  return quotes.map((q: any) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: q.close as number }))
}

/** Trailing N-day annualized realized vol as of (but excluding) asOfDate. */
function trailingRealizedVolPct(series: DailyClose[], asOfDate: string, windowDays = 20): number | null {
  const cutIdx = series.findIndex(p => p.date >= asOfDate)
  const endIdx = cutIdx === -1 ? series.length : cutIdx
  const slice = series.slice(Math.max(0, endIdx - windowDays - 1), endIdx)
  if (slice.length < 6) return null
  const rets: number[] = []
  for (let i = 1; i < slice.length; i++) rets.push(Math.log(slice[i].close / slice[i - 1].close))
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1)
  return Math.sqrt(variance) * Math.sqrt(252) * 100
}

/** First close on or after `date` — handles weekends/holidays landing on expiration. */
function closeOnOrAfter(series: DailyClose[], date: string): number | null {
  const row = series.find(p => p.date >= date)
  return row ? row.close : null
}

/** Running share count per account+symbol, built by replaying the equity
 * transaction ledger chronologically (buys add, sells/assignment_sells
 * subtract). Used only to answer "was this short call covered when opened" —
 * a simple share-count check, not a cost-basis reconstruction (that would be
 * needed to say whether an assignment was actually PROFITABLE, a materially
 * bigger project; this answers the narrower, still-useful "was it even a
 * covered call" question). */
function buildSharesHeldTimeline(transactions: PortfolioTransaction[]): Map<string, { date: string; shares: number }[]> {
  const bySymbolAccount = new Map<string, { date: string; shares: number }[]>()
  const running = new Map<string, number>()
  const rows = transactions
    .filter(t => ["equity_order", "assignment_buy", "assignment_sell"].includes(t.txnType ?? ""))
    .sort((a, b) => (a.txnDate?.getTime() ?? 0) - (b.txnDate?.getTime() ?? 0))
  for (const t of rows) {
    const key = `${t.account}::${t.symbol}`
    const qty = parseFloat(t.quantity ?? "0")
    const side = (t.side ?? "").toLowerCase()
    const tt = t.txnType ?? ""
    const isBuy = tt === "assignment_buy" || (tt === "equity_order" && side === "buy")
    const isSell = tt === "assignment_sell" || (tt === "equity_order" && side === "sell")
    if (!isBuy && !isSell) continue
    const prev = running.get(key) ?? 0
    const next = isBuy ? prev + qty : prev - qty
    running.set(key, next)
    if (!bySymbolAccount.has(key)) bySymbolAccount.set(key, [])
    bySymbolAccount.get(key)!.push({ date: (t.txnDate ?? new Date()).toISOString().slice(0, 10), shares: next })
  }
  return bySymbolAccount
}

/** Shares held as of (on or before) `date`, from a pre-built timeline. */
function sharesHeldAsOf(timeline: { date: string; shares: number }[] | undefined, date: string): number {
  if (!timeline || timeline.length === 0) return 0
  let shares = 0
  for (const point of timeline) {
    if (point.date > date) break
    shares = point.shares
  }
  return shares
}

export async function computeIvRankBacktest(
  allOrders: PortfolioOrder[],
  opts: { sinceDate?: string; transactions?: PortfolioTransaction[]; accountNickMap?: Map<string, string> } = {},
): Promise<IvRankBacktestResult> {
  const sinceDate = opts.sinceDate ?? "2026-01-01"
  const today = new Date().toISOString().slice(0, 10)
  const accountNickMap = opts.accountNickMap ?? new Map<string, string>()
  const canonicalAccount = (raw: string): string => accountNickMap.get(raw) ?? raw
  const sharesTimeline = buildSharesHeldTimeline(opts.transactions ?? [])

  // Short option opens only — this backtest targets the premium-selling
  // thesis specifically (cash-secured puts / covered calls), not long options.
  const eligible = allOrders.filter(o =>
    o.isOption && o.legEffect === "open" && o.legSide === "sell" &&
    o.state === "filled" && o.optionStrike && o.optionExpiration && o.premium &&
    o.createdAt && o.createdAt.toISOString().slice(0, 10) >= sinceDate &&
    o.optionExpiration < today, // only grade contracts whose expiration has passed
  )

  const tickers = [...new Set(eligible.map(o => o.symbol))]
  const seriesByTicker = new Map<string, DailyClose[]>()
  const tickersWithNoPriceHistory: string[] = []

  // Earnings dates (past + upcoming) per traded ticker, for the earnings-risk
  // flag backtest below — one query, not per-trade.
  const earningsRowsByTicker = new Map<string, string[]>()
  if (tickers.length > 0) {
    const rows = await db
      .select({ ticker: earningsCalendar.ticker, reportDate: earningsCalendar.reportDate })
      .from(earningsCalendar)
      .where(inArray(earningsCalendar.ticker, tickers))
    for (const r of rows) {
      if (!earningsRowsByTicker.has(r.ticker)) earningsRowsByTicker.set(r.ticker, [])
      earningsRowsByTicker.get(r.ticker)!.push(r.reportDate)
    }
  }

  for (const ticker of tickers) {
    const tickerOrders = eligible.filter(o => o.symbol === ticker)
    const earliestOpen = Math.min(...tickerOrders.map(o => o.createdAt!.getTime()))
    const latestExpiry = Math.max(...tickerOrders.map(o => new Date(o.optionExpiration!).getTime()))
    try {
      const series = await fetchDailyCloseSeries(
        ticker,
        new Date(earliestOpen - 40 * 86_400_000), // pad for the trailing-vol window
        new Date(latestExpiry + 3 * 86_400_000),
      )
      seriesByTicker.set(ticker, series)
      if (series.length === 0) tickersWithNoPriceHistory.push(ticker)
    } catch {
      seriesByTicker.set(ticker, [])
      tickersWithNoPriceHistory.push(ticker)
    }
  }

  const graded: GradedTrade[] = []
  for (const o of eligible) {
    const series = seriesByTicker.get(o.symbol) ?? []
    const openedAt = o.createdAt!.toISOString().slice(0, 10)
    const vol = trailingRealizedVolPct(series, openedAt)
    const underlyingAtExpiry = closeOnOrAfter(series, o.optionExpiration!)
    if (vol == null || underlyingAtExpiry == null) continue

    const strike = parseFloat(o.optionStrike!)
    const optionSide = (o.optionSide as "call" | "put") ?? "put"
    const keptFullPremium = optionSide === "put" ? underlyingAtExpiry >= strike : underlyingAtExpiry <= strike

    const openedAtMs = o.createdAt!.getTime()
    const expiryMs = new Date(o.optionExpiration!).getTime()
    const midpointDate = new Date(openedAtMs + (expiryMs - openedAtMs) / 2).toISOString().slice(0, 10)
    const underlyingAtMidHold = midpointDate > openedAt ? closeOnOrAfter(series, midpointDate) : null
    // Moneyness-proxy for "high delta" (true historical delta needs IV
    // history we don't have — see module docstring): within 2% of strike or
    // already past it. Tuned 2026-10-04 via moneynessBandSweep below — 2%
    // separates outcomes better than the 3% originally guessed (51.4pp vs
    // 42.9pp gap between flagged/unflagged ITM rates) while keeping a
    // reasonable sample (n=147 vs 191); 1% ties on separation with fewer
    // trades, so 2% is the better sample-size/signal tradeoff.
    const ASSIGNMENT_RISK_BAND_PCT = 2
    const flaggedAtRiskMidHold = underlyingAtMidHold == null ? null
      : optionSide === "put" ? underlyingAtMidHold <= strike * (1 + ASSIGNMENT_RISK_BAND_PCT / 100)
      : underlyingAtMidHold >= strike * (1 - ASSIGNMENT_RISK_BAND_PCT / 100)

    const earningsDates = earningsRowsByTicker.get(o.symbol) ?? []
    const earningsInWindow = earningsDates.some(d => d >= openedAt && d <= o.optionExpiration!)

    const qty = parseFloat(o.quantity ?? "1")
    const isCoveredCall = optionSide === "call"
      ? sharesHeldAsOf(sharesTimeline.get(`${canonicalAccount(o.account)}::${o.symbol}`), openedAt) >= 100 * qty
      : null

    graded.push({
      symbol: o.symbol, optionSide, strike, openedAt, expiration: o.optionExpiration!,
      premium: parseFloat(o.premium!), qty,
      trailingVol20dAnnualizedPct: vol, underlyingAtExpiry, keptFullPremium,
      underlyingAtMidHold, flaggedAtRiskMidHold, earningsInWindow, isCoveredCall,
    })
  }

  const sorted = [...graded].sort((a, b) => a.trailingVol20dAnnualizedPct - b.trailingVol20dAnnualizedPct)
  const n = sorted.length
  const bucketLabel = (i: number): "Low" | "Mid" | "High" => (i < n / 3 ? "Low" : i < (2 * n) / 3 ? "Mid" : "High")

  const bucketAcc: Record<"Low" | "Mid" | "High", GradedTrade[]> = { Low: [], Mid: [], High: [] }
  sorted.forEach((t, i) => bucketAcc[bucketLabel(i)].push(t))

  const buckets = (["Low", "Mid", "High"] as const).map(bucket => {
    const rows = bucketAcc[bucket]
    const count = rows.length
    const kept = rows.filter(r => r.keptFullPremium).length
    return {
      bucket, count,
      keptFullPremiumPct: count > 0 ? (kept / count) * 100 : 0,
      avgPremiumPerContract: count > 0 ? rows.reduce((s, r) => s + r.premium, 0) / count : 0,
      avgTrailingVol20dAnnualizedPct: count > 0 ? rows.reduce((s, r) => s + r.trailingVol20dAnnualizedPct, 0) / count : 0,
    }
  })

  const checkable = graded.filter(t => t.flaggedAtRiskMidHold != null)
  const flagged = checkable.filter(t => t.flaggedAtRiskMidHold)
  const unflagged = checkable.filter(t => !t.flaggedAtRiskMidHold)
  const assignmentRiskCheckpoint = {
    checkedCount: checkable.length,
    flaggedCount: flagged.length,
    flaggedWentItmPct: flagged.length > 0 ? (flagged.filter(t => !t.keptFullPremium).length / flagged.length) * 100 : 0,
    unflaggedCount: unflagged.length,
    unflaggedWentItmPct: unflagged.length > 0 ? (unflagged.filter(t => !t.keptFullPremium).length / unflagged.length) * 100 : 0,
  }

  const inWindow = graded.filter(t => t.earningsInWindow)
  const outsideWindow = graded.filter(t => !t.earningsInWindow)
  const earningsRiskCheck = {
    inWindowCount: inWindow.length,
    inWindowKeptFullPremiumPct: inWindow.length > 0 ? (inWindow.filter(t => t.keptFullPremium).length / inWindow.length) * 100 : 0,
    outsideWindowCount: outsideWindow.length,
    outsideWindowKeptFullPremiumPct: outsideWindow.length > 0 ? (outsideWindow.filter(t => t.keptFullPremium).length / outsideWindow.length) * 100 : 0,
  }

  // Threshold sweep: recompute the "flagged" moneyness band at several widths
  // against the already-fetched midpoint prices (no new price fetches needed).
  const withMidHold = graded.filter(t => t.underlyingAtMidHold != null)
  const moneynessBandSweep = [1, 2, 3, 5, 8, 12].map(bandPct => {
    const isFlagged = (t: GradedTrade) => {
      const mid = t.underlyingAtMidHold!
      return t.optionSide === "put" ? mid <= t.strike * (1 + bandPct / 100) : mid >= t.strike * (1 - bandPct / 100)
    }
    const flagged = withMidHold.filter(isFlagged)
    const unflagged = withMidHold.filter(t => !isFlagged(t))
    const flaggedWentItmPct = flagged.length > 0 ? (flagged.filter(t => !t.keptFullPremium).length / flagged.length) * 100 : 0
    const unflaggedWentItmPct = unflagged.length > 0 ? (unflagged.filter(t => !t.keptFullPremium).length / unflagged.length) * 100 : 0
    return { bandPct, flaggedCount: flagged.length, flaggedWentItmPct, unflaggedWentItmPct, separation: flaggedWentItmPct - unflaggedWentItmPct }
  })

  const callTrades = graded.filter(t => t.optionSide === "call")
  const itmCallTrades = callTrades.filter(t => !t.keptFullPremium)
  const coveredCallCheck = {
    totalCallTrades: callTrades.length,
    itmCallTrades: itmCallTrades.length,
    coveredItmCount: itmCallTrades.filter(t => t.isCoveredCall === true).length,
    nakedOrUnknownItmCount: itmCallTrades.filter(t => t.isCoveredCall !== true).length,
  }

  return { buckets, trades: sorted, totalEligible: eligible.length, graded: graded.length, tickersWithNoPriceHistory, assignmentRiskCheckpoint, earningsRiskCheck, moneynessBandSweep, coveredCallCheck }
}
