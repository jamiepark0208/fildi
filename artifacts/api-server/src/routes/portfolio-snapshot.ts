import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth.js'
import { db, portfolioSnapshots, portfolioPositions, portfolioOptions, portfolioAccountSummaries, portfolioOrders } from '@workspace/db'
import { desc, eq } from 'drizzle-orm'
import { computeRealizedPnL } from '../lib/realized-pnl.js'

const router = Router()

router.get('/portfolio/snapshot/latest', requireAuth, async (req, res, next) => {
  try {
    const [snapshot] = await db
      .select()
      .from(portfolioSnapshots)
      .orderBy(desc(portfolioSnapshots.importedAt))
      .limit(1)

    if (!snapshot) {
      res.json({ snapshot: null, positions: [], options: [], accountSummaries: [], realizedEvents: [] })
      return
    }

    const [positions, options, accountSummaries, orders] = await Promise.all([
      db.select().from(portfolioPositions).where(eq(portfolioPositions.snapshotId, snapshot.id)),
      db.select().from(portfolioOptions).where(eq(portfolioOptions.snapshotId, snapshot.id)),
      db.select().from(portfolioAccountSummaries).where(eq(portfolioAccountSummaries.snapshotId, snapshot.id)),
      db.select().from(portfolioOrders).where(eq(portfolioOrders.snapshotId, snapshot.id)),
    ])

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

    res.json({ snapshot, positions, options, accountSummaries, realizedEvents })
  } catch (err) {
    next(err)
  }
})

export default router
