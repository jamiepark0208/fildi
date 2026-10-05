import { Router } from 'express'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { db, portfolioSnapshots, portfolioPositions, portfolioOptions, portfolioAccountSummaries, portfolioTransactions, portfolioTickerEarnings } from '@workspace/db'
import { desc, eq } from 'drizzle-orm'
import { computeRealizedPnL } from '../lib/realized-pnl.js'
import { computePortfolioRisk, type PortfolioRiskInput } from '../lib/portfolio-risk.js'
import { getUpcomingEarningsDates } from '../lib/earnings-history.js'
import { getMergedOrders, getAccountNickMap } from '../lib/portfolio-orders.js'
import { computeIvRankBacktest, type IvRankBacktestResult } from '../lib/iv-rank-backtest.js'

const router = Router()

// In-memory cache — this backtest makes one Yahoo Finance call per distinct
// ticker traded (not per trade), but there's no reason to redo that on every
// page load when the underlying trade history only changes once/day via the
// collection pipeline. 6h TTL, single global entry (no per-request params yet).
let ivRankCache: { computedAt: number; result: IvRankBacktestResult } | null = null
const IV_RANK_CACHE_MS = 6 * 60 * 60 * 1000

router.get('/portfolio/iv-rank-backtest', requireAdmin, async (req, res, next) => {
  try {
    const force = req.query['refresh'] === 'true'
    if (!force && ivRankCache && Date.now() - ivRankCache.computedAt < IV_RANK_CACHE_MS) {
      res.json(ivRankCache.result)
      return
    }
    const [orders, transactions, accountNickMap] = await Promise.all([
      getMergedOrders(),
      db.select().from(portfolioTransactions),
      getAccountNickMap(),
    ])
    const result = await computeIvRankBacktest(orders, { transactions, accountNickMap })
    ivRankCache = { computedAt: Date.now(), result }
    res.json(result)
  } catch (err) {
    next(err)
  }
})

// Correlation matrix + parametric 95% VaR/CVaR across held tickers. Frontend
// supplies { ticker, weight } pairs (it already computes notional weights for
// the beta-contribution card) rather than this route re-deriving position
// sizing from CSV/manual-entry data. Portfolio feature is admin-only for now
// (regular-user manual-entry UX not yet built — see enh/8).
router.post('/portfolio/risk', requireAdmin, async (req, res, next) => {
  try {
    const { positions, portfolioValueUsd } = req.body as { positions?: PortfolioRiskInput[]; portfolioValueUsd?: number }
    if (!Array.isArray(positions) || positions.length === 0) {
      res.json({ tickers: [], correlationMatrix: [], dailyVolatilityPct: 0, var95Pct: 0, cvar95Pct: 0, var95Usd: 0, cvar95Usd: 0, skippedTickers: [] })
      return
    }
    const result = await computePortfolioRisk(positions, portfolioValueUsd ?? 0)
    res.json(result)
  } catch (err) {
    next(err)
  }
})

router.get('/portfolio/snapshot/latest', requireAdmin, async (req, res, next) => {
  try {
    const [snapshot] = await db
      .select()
      .from(portfolioSnapshots)
      .orderBy(desc(portfolioSnapshots.importedAt))
      .limit(1)

    // Transactions and ticker earnings are NOT scoped to a single holdings
    // snapshot — they accumulate/upsert across imports independently (see
    // portfolio_transactions / portfolio_ticker_earnings schema comments) —
    // so they're fetched regardless of whether a holdings snapshot exists yet.
    const [transactions, tickerEarnings] = await Promise.all([
      db.select().from(portfolioTransactions).orderBy(desc(portfolioTransactions.txnDate)),
      db.select().from(portfolioTickerEarnings),
    ])

    if (!snapshot) {
      const { events: realizedEvents, orphanedStockLots } = computeRealizedPnL([], transactions, new Set())
      res.json({ snapshot: null, positions: [], options: [], accountSummaries: [], realizedEvents, orphanedStockLots, transactions, tickerEarnings, earningsCalendar: {} })
      return
    }

    const [positions, options, accountSummaries, orders] = await Promise.all([
      db.select().from(portfolioPositions).where(eq(portfolioPositions.snapshotId, snapshot.id)),
      db.select().from(portfolioOptions).where(eq(portfolioOptions.snapshotId, snapshot.id)),
      db.select().from(portfolioAccountSummaries).where(eq(portfolioAccountSummaries.snapshotId, snapshot.id)),
      getMergedOrders(),
    ])

    // Holdings keys use export nicknames (FILDI / IRA) so they match
    // portfolio_transactions.account — assignment FIFO and orphan detection share that namespace.
    const nickByAccountId = new Map<string, string>()
    for (const a of accountSummaries) {
      const nick = a.nickname ?? a.account
      // Normalize "Traditional IRA" → "IRA" to match txn / ticker-earnings export labels.
      nickByAccountId.set(a.account, nick === 'Traditional IRA' ? 'IRA' : nick)
    }
    for (const p of positions) {
      if (p.accountNickname && !nickByAccountId.has(p.account)) {
        nickByAccountId.set(p.account, p.accountNickname === 'Traditional IRA' ? 'IRA' : p.accountNickname)
      }
    }
    const heldKeys = new Set<string>()
    for (const p of positions) {
      const nick = nickByAccountId.get(p.account) ?? p.accountNickname ?? p.account
      const qty = parseFloat(p.quantity ?? '0')
      if (qty > 1e-9) heldKeys.add(`${nick}::${p.symbol}`)
    }

    const { events: realizedEvents, orphanedStockLots } = computeRealizedPnL(orders, transactions, heldKeys, nickByAccountId)

    const accountTotal = accountSummaries.reduce((s, a) => s + parseFloat(a.totalValue ?? '0'), 0)
    const stockPnl = realizedEvents.filter(e => e.assetType === 'stock').reduce((s, e) => s + e.pnl, 0)
    const optShortPnl = realizedEvents.filter(e => e.assetType === 'option' && e.direction === 'short').reduce((s, e) => s + e.pnl, 0)
    const optLongPnl = realizedEvents.filter(e => e.assetType === 'option' && e.direction === 'long').reduce((s, e) => s + e.pnl, 0)
    console.log(
      `[portfolio/snapshot/latest] snapshot=${snapshot.id} accountSummaryTotal=${accountTotal.toFixed(2)} ` +
      `snapshotTotalValue=${snapshot.totalValue} (should match) | realizedEvents=${realizedEvents.length} ` +
      `stockPnl=${stockPnl.toFixed(2)} optionShortPnl=${optShortPnl.toFixed(2)} optionLongPnl=${optLongPnl.toFixed(2)} ` +
      `totalRealized=${(stockPnl + optShortPnl + optLongPnl).toFixed(2)} ` +
      `orphanedLots=${orphanedStockLots.length}`
    )

    // Earnings-risk flag: next scheduled report date per ticker currently held
    // via an open option, so the frontend can flag any contract whose
    // expiration spans an earnings date — IV crush risk, worst on exactly the
    // high-IV small/mid-caps this account sells premium on.
    const optionTickers = [...new Set(options.map(o => o.symbol))]
    const earningsCalendar = await getUpcomingEarningsDates(optionTickers)

    res.json({ snapshot, positions, options, accountSummaries, realizedEvents, orphanedStockLots, transactions, tickerEarnings, earningsCalendar })
  } catch (err) {
    next(err)
  }
})

export default router
