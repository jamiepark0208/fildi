import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth.js'
import { db, portfolioSnapshots, portfolioPositions, portfolioOptions, portfolioAccountSummaries } from '@workspace/db'
import { desc, eq } from 'drizzle-orm'

const router = Router()

router.get('/portfolio/snapshot/latest', requireAuth, async (req, res, next) => {
  try {
    const [snapshot] = await db
      .select()
      .from(portfolioSnapshots)
      .orderBy(desc(portfolioSnapshots.importedAt))
      .limit(1)

    if (!snapshot) {
      res.json({ snapshot: null, positions: [], options: [], accountSummaries: [] })
      return
    }

    const [positions, options, accountSummaries] = await Promise.all([
      db.select().from(portfolioPositions).where(eq(portfolioPositions.snapshotId, snapshot.id)),
      db.select().from(portfolioOptions).where(eq(portfolioOptions.snapshotId, snapshot.id)),
      db.select().from(portfolioAccountSummaries).where(eq(portfolioAccountSummaries.snapshotId, snapshot.id)),
    ])

    res.json({ snapshot, positions, options, accountSummaries })
  } catch (err) {
    next(err)
  }
})

export default router
