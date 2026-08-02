import { and, eq, lt, sql } from 'drizzle-orm'
import { db, tradePosts, pricesHistorical } from '@workspace/db'
import { fetchAndStoreOHLCV } from './indicators.js'
import { logger } from './logger.js'

const OPTION_TYPES = new Set(['SELL_PUT', 'BUY_PUT', 'SELL_CALL', 'BUY_CALL'])

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
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
      const isShort   = post.tradeType === 'SELL_PUT' || post.tradeType === 'SELL_CALL'
      const pnlPerContract = isShort ? premium - intrinsic : intrinsic - premium
      const resolvedPnl = pnlPerContract * post.contracts * 100
      const status = resolvedPnl > 0 ? 'EXPIRED_WIN' : 'EXPIRED_LOSS'

      await db.update(tradePosts).set({
        status,
        resolvedAt:  new Date(),
        resolvedPnl: String(resolvedPnl),
        updatedAt:   new Date(),
      }).where(eq(tradePosts.id, post.id))

      if (status === 'EXPIRED_WIN') resolvedWin++
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
