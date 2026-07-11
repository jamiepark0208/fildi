import { Router } from 'express'
import { requireAuth } from '../middleware/requireAuth.js'
import {
  db,
  portfolioSnapshots,
  portfolioAccountSummaries,
  portfolioPositions,
  portfolioEquityFundamentals,
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
          cashBalance: parsed.cashBalance != null ? String(parsed.cashBalance) : null,
          cryptoValue: parsed.cryptoValue != null ? String(parsed.cryptoValue) : null,
          rawFilename: null,
        })
        .returning({ id: portfolioSnapshots.id })

      const snapshotId = snapshot.id

      // ── Insert per-account summaries ───────────────────────────────────────
      if (parsed.accountSummaries.length > 0) {
        await db.insert(portfolioAccountSummaries).values(
          parsed.accountSummaries.map(a => ({
            snapshotId,
            account:        a.account,
            nickname:       a.nickname,
            type:           a.type,
            totalValue:     a.totalValue,
            equityValue:    a.equityValue,
            optionsValue:   a.optionsValue,
            cryptoValue:    a.cryptoValue,
            eventContracts: a.eventContracts,
            cash:           a.cash,
            marginUsed:     a.marginUsed,
            buyingPower:    a.buyingPower,
            unleveragedBp:  a.unleveragedBp,
          }))
        )
      }

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
            extHoursPrice:   p.extHoursPrice,
            marketValue:     p.marketValue,
            costBasis:       p.costBasis,
            unrealizedPnL:   p.unrealizedPnL,
            pnlPct:          p.pnlPct,
            dayChangePct:    p.dayChangePct,
            bid:             p.bid,
            ask:             p.ask,
            prevClose:       p.prevClose,
          }))
        )
      }

      // ── Insert equity fundamentals ─────────────────────────────────────────
      if (parsed.equityFundamentals.length > 0) {
        await db.insert(portfolioEquityFundamentals).values(
          parsed.equityFundamentals.map(f => ({
            snapshotId,
            symbol:            f.symbol,
            open:              f.open,
            high:              f.high,
            low:               f.low,
            volume:            f.volume,
            avgVol2w:          f.avgVol2w,
            marketCap:         f.marketCap,
            peRatio:           f.peRatio,
            pbRatio:           f.pbRatio,
            week52High:        f.week52High,
            week52Low:         f.week52Low,
            sharesOutstanding: f.sharesOutstanding,
            divPerShare:       f.divPerShare,
            divYield:          f.divYield,
            sector:            f.sector,
            industry:          f.industry,
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
            adjMark:       o.adjMark,
            currentValue:  o.currentValue,
            unrealizedPnL: o.unrealizedPnL,
            pnlPct:        o.pnlPct,
            bid:           o.bid,
            ask:           o.ask,
            prevClose:     o.prevClose,
            iv:            o.iv,
            delta:         o.delta,
            gamma:         o.gamma,
            theta:         o.theta,
            vega:          o.vega,
            openInterest:  o.openInterest,
            volume:        o.volume,
          }))
        )
      }

      // ── Insert orders ──────────────────────────────────────────────────────
      if (parsed.orders.length > 0) {
        await db.insert(portfolioOrders).values(
          parsed.orders.map(ord => ({
            snapshotId,
            orderId:           ord.orderId,
            account:           ord.account,
            symbol:            ord.symbol,
            side:              ord.side,
            orderType:         ord.orderType,
            state:             ord.state,
            quantity:          ord.quantity,
            cumulativeQty:     ord.cumulativeQty,
            processedQty:      ord.processedQty,
            canceledQty:       ord.canceledQty,
            limitPrice:        ord.limitPrice,
            stopPrice:         ord.stopPrice,
            avgFillPrice:      ord.avgFillPrice,
            premium:           ord.premium,
            processedPremium:  ord.processedPremium,
            fees:              ord.fees,
            timeInForce:       ord.timeInForce,
            marketHours:       ord.marketHours,
            placedAgent:       ord.placedAgent,
            createdAt:         ord.createdAt ? new Date(ord.createdAt) : null,
            lastTransactionAt: ord.lastTransactionAt ? new Date(ord.lastTransactionAt) : null,
            isOption:          ord.isOption,
            optionStrike:      ord.optionStrike,
            optionExpiration:  ord.optionExpiration,
            optionSide:        ord.optionSide,
            legSide:           ord.legSide,
            legEffect:         ord.legEffect,
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
