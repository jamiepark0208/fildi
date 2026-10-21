import { and, asc, eq, lt, sql } from 'drizzle-orm'
import { db, tradePosts, pricesHistorical, stockHoldings, users } from '@workspace/db'
import { fetchAndStoreOHLCV } from './indicators.js'
import { logger } from './logger.js'
import { etDateKey } from './market-hours.js'

const OPTION_TYPES = new Set(['SELL_PUT', 'BUY_PUT', 'SELL_CALL', 'BUY_CALL'])

function todayStr(): string {
  return etDateKey() // ET market date (was UTC: rolled to tomorrow after 5 PM PT, 10-20)
}

// Put-side (SELL_PUT/BUY_PUT) is ITM below strike; call-side is ITM above strike.
function intrinsicValue(tradeType: string, strike: number, closePrice: number): number {
  return tradeType === 'SELL_PUT' || tradeType === 'BUY_PUT'
    ? Math.max(strike - closePrice, 0)
    : Math.max(closePrice - strike, 0)
}

// A row satisfying `date <= expiry` can still be weeks stale if the ticker's
// price history stopped refreshing (see indicators.ts staleness fix) — settling
// a trade against that row silently uses the wrong close. This caps how far
// back of the expiry a settlement row is trusted; anything older is treated
// the same as "no data" so callers refetch instead of grading on it.
const MAX_SETTLE_STALENESS_DAYS = 4 // covers weekends/a single holiday

export async function closeOnOrBeforeExpiryChecked(
  ticker: string,
  expiry: string,
): Promise<{ close: number; date: string } | null> {
  const rows = await db
    .select({ close: pricesHistorical.close, date: pricesHistorical.date })
    .from(pricesHistorical)
    .where(and(eq(pricesHistorical.ticker, ticker), sql`${pricesHistorical.date} <= ${expiry}`))
    .orderBy(sql`${pricesHistorical.date} DESC`)
    .limit(1)
  const row = rows[0]
  if (row?.close == null || row.date == null) return null

  const staleDays = (new Date(expiry).getTime() - new Date(row.date).getTime()) / 86_400_000
  if (staleDays > MAX_SETTLE_STALENESS_DAYS) return null

  return { close: Number(row.close), date: row.date }
}

/**
 * Auto-resolves option trade ideas left OPEN past their expiry — settles them
 * against the underlying's close on/before expiry instead of leaving a stale
 * OPEN badge on an option that's no longer live. Manual closes always set
 * status='CLOSED' regardless of pnl (see PATCH /feed/posts/:id/close) — this
 * only covers ideas nobody closed by hand before expiry.
 */
export async function resolveExpiredOptionTrades(): Promise<void> {
  const expired = await db
    .select()
    .from(tradePosts)
    .where(and(
      eq(tradePosts.status, 'OPEN'),
      lt(tradePosts.expiry, todayStr()),
      sql`${tradePosts.tradeType} IN ('SELL_PUT','BUY_PUT','SELL_CALL','BUY_CALL')`,
    ))
  if (expired.length === 0) {
    logger.info('trade-post-expiry: no expired OPEN trades found')
    return
  }

  let resolvedWin = 0
  let resolvedLoss = 0
  let skippedNoPrice = 0
  let failed = 0

  for (const post of expired) {
    try {
      let settle = await closeOnOrBeforeExpiryChecked(post.ticker, post.expiry)
      if (settle == null) {
        await fetchAndStoreOHLCV(post.ticker).catch(() => {})
        settle = await closeOnOrBeforeExpiryChecked(post.ticker, post.expiry)
      }
      if (settle == null) {
        logger.warn({ ticker: post.ticker, postId: post.id }, 'trade-post-expiry: no fresh price data, leaving OPEN')
        skippedNoPrice++
        continue
      }
      const closePrice = settle.close

      const strike    = Number(post.strike)
      const premium   = Number(post.premiumPerContract)
      const intrinsic = intrinsicValue(post.tradeType, strike, closePrice)
      const shares    = post.contracts * 100
      const assigned  = intrinsic > 0

      const { status, resolvedPnl } = await db.transaction(async tx => {
        let status: string
        let resolvedPnl: number
        // Cash movement on resolution only — the premium (SELL_*) or cost (BUY_*)
        // leg was already applied to users.cashBalance when the trade was opened
        // (see POST /api/feed/posts), so this only books what changes at settlement.
        let cashDelta = 0

        if (post.tradeType === 'SELL_PUT' && assigned) {
          // Wheel-strategy assignment: the premium is kept regardless of what the
          // stock does next, so it's booked as realized income here — NOT netted
          // against intrinsic value like a closed position would be. The share
          // position this creates is tracked separately in stock_holdings, marked
          // to market on its own (see feed.ts profile route), so folding the
          // stock's move into this trade's resolvedPnl would double-count it.
          status = 'ASSIGNED'
          resolvedPnl = premium * post.contracts * 100
          cashDelta = -strike * post.contracts * 100 // buys the stock at strike

          await tx.insert(stockHoldings).values({
            userId:           post.userId,
            ticker:           post.ticker,
            shares,
            costBasis:        String(strike),
            source:           'PUT_ASSIGNMENT',
            status:           'OPEN',
            openedFromPostId: post.id,
            notes:            `Assigned from put sold at $${strike} (exp ${post.expiry})`,
          })
        } else if (post.tradeType === 'SELL_CALL' && assigned) {
          // Covered-call assignment: shares called away. Look up the oldest open
          // long-source lot for this ticker/user — if one exists this is a covered
          // call closing that lot; otherwise it's a naked call and falls back to
          // the old closed-position math below (should only fire for pre-existing
          // rows created before covered calls were enforced at creation time).
          const [holding] = await tx
            .select()
            .from(stockHoldings)
            .where(and(
              eq(stockHoldings.userId, post.userId),
              eq(stockHoldings.ticker, post.ticker),
              eq(stockHoldings.status, 'OPEN'),
              sql`${stockHoldings.shares} > 0`,
            ))
            .orderBy(asc(stockHoldings.openedAt))
            .limit(1)

          if (holding) {
            status = 'ASSIGNED'
            resolvedPnl = premium * post.contracts * 100
            cashDelta = strike * post.contracts * 100 // shares sold at strike

            const holdingRealizedPnl = (strike - Number(holding.costBasis)) * holding.shares
            await tx.update(stockHoldings).set({
              status:         'CALLED_AWAY',
              closedByPostId: post.id,
              realizedPnl:    String(holdingRealizedPnl),
              closedAt:       new Date(),
            }).where(eq(stockHoldings.id, holding.id))
          } else {
            const pnlPerContract = premium - intrinsic
            resolvedPnl = pnlPerContract * post.contracts * 100
            status = resolvedPnl > 0 ? 'EXPIRED_WIN' : 'EXPIRED_LOSS'
          }
        } else if (post.tradeType === 'BUY_PUT' || post.tradeType === 'BUY_CALL') {
          const pnlPerContract = intrinsic - premium
          resolvedPnl = pnlPerContract * post.contracts * 100
          status = resolvedPnl > 0 ? 'EXPIRED_WIN' : 'EXPIRED_LOSS'
          cashDelta = intrinsic * post.contracts * 100 // exercise payout, 0 if OTM
        } else {
          const isShort = post.tradeType === 'SELL_PUT' || post.tradeType === 'SELL_CALL'
          const pnlPerContract = isShort ? premium - intrinsic : intrinsic - premium
          resolvedPnl = pnlPerContract * post.contracts * 100
          status = resolvedPnl > 0 ? 'EXPIRED_WIN' : 'EXPIRED_LOSS'
        }

        if (cashDelta !== 0) {
          await tx.update(users)
            .set({ cashBalance: sql`${users.cashBalance} + ${cashDelta}` })
            .where(eq(users.id, post.userId))
        }

        await tx.update(tradePosts).set({
          status,
          resolvedAt:  new Date(),
          resolvedPnl: String(resolvedPnl),
          updatedAt:   new Date(),
        }).where(eq(tradePosts.id, post.id))

        return { status, resolvedPnl }
      })

      if (status === 'EXPIRED_WIN' || status === 'ASSIGNED') resolvedWin++
      else resolvedLoss++
      logger.info(
        { ticker: post.ticker, postId: post.id, expiry: post.expiry, closePrice, status, resolvedPnl },
        'trade-post-expiry: resolved trade',
      )
    } catch (err) {
      logger.error({ err, postId: post.id, ticker: post.ticker }, 'trade-post-expiry: failed to resolve')
      failed++
    }
  }

  logger.info(
    { found: expired.length, resolvedWin, resolvedLoss, skippedNoPrice, failed },
    'trade-post-expiry: resolution run complete',
  )
}
