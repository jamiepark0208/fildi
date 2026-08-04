import { Router } from 'express'
import { requireAdmin } from '../middleware/requireAdmin.js'
import { db, portfolioSnapshots, portfolioPositions, portfolioOptions, portfolioAccountSummaries, portfolioOrders, portfolioTransactions, portfolioTickerEarnings } from '@workspace/db'
import { desc, eq } from 'drizzle-orm'
import { computeRealizedPnL } from '../lib/realized-pnl.js'
import { computePortfolioRisk, type PortfolioRiskInput } from '../lib/portfolio-risk.js'

const router = Router()

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
      res.json({ snapshot: null, positions: [], options: [], accountSummaries: [], realizedEvents: [], transactions, tickerEarnings })
      return
    }

    const [positions, options, accountSummaries, ordersForLatest] = await Promise.all([
      db.select().from(portfolioPositions).where(eq(portfolioPositions.snapshotId, snapshot.id)),
      db.select().from(portfolioOptions).where(eq(portfolioOptions.snapshotId, snapshot.id)),
      db.select().from(portfolioAccountSummaries).where(eq(portfolioAccountSummaries.snapshotId, snapshot.id)),
      db.select().from(portfolioOrders).where(eq(portfolioOrders.snapshotId, snapshot.id)),
    ])

    // Orders (the full equity/option order book) aren't re-exported on every import —
    // some imports only refresh holdings/account-summary CSVs — so if the latest
    // snapshot has none, fall back to the most recent snapshot that does, rather than
    // silently reporting zero realized P&L.
    let orders = ordersForLatest
    if (orders.length === 0) {
      const [latestWithOrders] = await db
        .select({ snapshotId: portfolioOrders.snapshotId })
        .from(portfolioOrders)
        .orderBy(desc(portfolioOrders.snapshotId))
        .limit(1)
      if (latestWithOrders) {
        orders = await db.select().from(portfolioOrders).where(eq(portfolioOrders.snapshotId, latestWithOrders.snapshotId))
      }
    }

    const realizedEvents = computeRealizedPnL(orders)

    const accountTotal = accountSummaries.reduce((s, a) => s + parseFloat(a.totalValue ?? '0'), 0)
    const stockPnl = realizedEvents.filter(e => e.assetType === 'stock').reduce((s, e) => s + e.pnl, 0)
    const optShortPnl = realizedEvents.filter(e => e.assetType === 'option' && e.direction === 'short').reduce((s, e) => s + e.pnl, 0)
    const optLongPnl = realizedEvents.filter(e => e.assetType === 'option' && e.direction === 'long').reduce((s, e) => s + e.pnl, 0)
    console.log(
      `[portfolio/snapshot/latest] snapshot=${snapshot.id} accountSummaryTotal=${accountTotal.toFixed(2)} ` +
      `snapshotTotalValue=${snapshot.totalValue} (should match) | realizedEvents=${realizedEvents.length} ` +
      `stockPnl=${stockPnl.toFixed(2)} optionShortPnl=${optShortPnl.toFixed(2)} optionLongPnl=${optLongPnl.toFixed(2)} ` +
      `totalRealized=${(stockPnl + optShortPnl + optLongPnl).toFixed(2)}`
    )

    res.json({ snapshot, positions, options, accountSummaries, realizedEvents, transactions, tickerEarnings })
  } catch (err) {
    next(err)
  }
})

export default router
