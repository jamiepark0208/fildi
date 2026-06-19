import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth.js'
import {
  db,
  portfolioSnapshots,
  portfolioPositions,
  portfolioOptions,
  portfolioOrders,
} from '@workspace/db'
import { parseRobinhoodCSV } from '../lib/portfolio-parser.js'

const router = Router()

// Accept raw CSV text body (text/plain, text/csv) or JSON { csv: "..." }
router.post(
  '/portfolio/ingest',
  requireAuth,
  async (req, res, next) => {
    try {
      let csvText: string | undefined

      const ct = req.headers['content-type'] ?? ''

      if (ct.startsWith('text/')) {
        // Raw text body — express.text() not mounted globally, so read manually
        csvText = await new Promise<string>((resolve, reject) => {
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
          req.on('end', () => resolve(body))
          req.on('error', reject)
        })
      } else {
        // JSON body: { csv: "..." } — already parsed by express.json()
        csvText = typeof req.body?.csv === 'string' ? req.body.csv : undefined
      }

      if (!csvText || csvText.trim().length === 0) {
        res.status(400).json({ code: 'MISSING_CSV', message: 'No CSV content provided.' })
        return
      }

      const parsed = parseRobinhoodCSV(csvText)

      // ── Insert snapshot ────────────────────────────────────────────────────
      const [snapshot] = await db
        .insert(portfolioSnapshots)
        .values({
          accountIds: parsed.accountIds,
          totalValue: parsed.totalValue != null ? String(parsed.totalValue) : null,
          rawFilename: null,
        })
        .returning({ id: portfolioSnapshots.id })

      const snapshotId = snapshot.id

      // ── Insert positions ───────────────────────────────────────────────────
      if (parsed.positions.length > 0) {
        await db.insert(portfolioPositions).values(
          parsed.positions.map(p => ({
            snapshotId,
            account:         p.account,
            accountNickname: p.accountNickname ?? null,
            symbol:          p.symbol,
            quantity:        p.quantity,
            avgCost:         p.avgCost,
            lastPrice:       p.lastPrice,
            marketValue:     p.marketValue,
            costBasis:       p.costBasis,
            unrealizedPnL:   p.unrealizedPnL,
            pnlPct:          p.pnlPct,
            dayChangePct:    p.dayChangePct,
            bid:             p.bid,
            ask:             p.ask,
          }))
        )
      }

      // ── Insert options ─────────────────────────────────────────────────────
      if (parsed.options.length > 0) {
        await db.insert(portfolioOptions).values(
          parsed.options.map(o => ({
            snapshotId,
            account:       o.account,
            symbol:        o.symbol,
            optionType:    o.optionType,
            strike:        o.strike,
            expiration:    o.expiration,
            direction:     o.direction,
            qty:           o.qty,
            avgPremium:    o.avgPremium,
            totalPremium:  o.totalPremium,
            markPrice:     o.markPrice,
            unrealizedPnL: o.unrealizedPnL,
            pnlPct:        o.pnlPct,
            iv:            o.iv,
            delta:         o.delta,
            gamma:         o.gamma,
            theta:         o.theta,
            vega:          o.vega,
          }))
        )
      }

      // ── Insert orders ──────────────────────────────────────────────────────
      if (parsed.orders.length > 0) {
        await db.insert(portfolioOrders).values(
          parsed.orders.map(ord => ({
            snapshotId,
            account:       ord.account,
            symbol:        ord.symbol,
            side:          ord.side,
            orderType:     ord.orderType,
            state:         ord.state,
            quantity:      ord.quantity,
            avgFillPrice:  ord.avgFillPrice,
            createdAt:        ord.createdAt ? new Date(ord.createdAt) : null,
            isOption:         ord.isOption,
            optionStrike:     ord.optionStrike,
            optionExpiration: ord.optionExpiration,
            optionSide:       ord.optionSide,
          }))
        )
      }

      res.json({
        success:       true,
        snapshotId,
        positionCount: parsed.positions.length,
        optionCount:   parsed.options.length,
        orderCount:    parsed.orders.length,
      })
    } catch (err) {
      next(err)
    }
  }
)

export default router
