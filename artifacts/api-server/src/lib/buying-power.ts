import { and, eq, sql } from 'drizzle-orm'
import { db, users, tradePosts, stockHoldings } from '@workspace/db'

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]
type Db = typeof db | Tx

export class InsufficientFundsError extends Error {}

export async function getCashBalance(userId: number, tx: Db = db): Promise<number> {
  const [row] = await tx.select({ cashBalance: users.cashBalance }).from(users).where(eq(users.id, userId))
  return row?.cashBalance != null ? Number(row.cashBalance) : 0
}

// SUM(strike * 100 * contracts) over the user's currently-OPEN SELL_PUT trade_posts —
// cash-secured put collateral is a derived quantity, not a stored reservation.
export async function reservedPutCollateral(userId: number, tx: Db = db): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string | null>`SUM(${tradePosts.strike} * 100 * ${tradePosts.contracts})` })
    .from(tradePosts)
    .where(and(eq(tradePosts.userId, userId), eq(tradePosts.tradeType, 'SELL_PUT'), eq(tradePosts.status, 'OPEN')))
  return row?.total != null ? Number(row.total) : 0
}

// SUM(costBasis * ABS(shares)) over the user's currently-OPEN short-source holdings —
// shorts require the same 100% cash collateral as cash-secured puts.
export async function reservedShortCollateral(userId: number, tx: Db = db): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string | null>`SUM(${stockHoldings.costBasis} * ABS(${stockHoldings.shares}))` })
    .from(stockHoldings)
    .where(and(eq(stockHoldings.userId, userId), eq(stockHoldings.source, 'SHORT_TRADE'), eq(stockHoldings.status, 'OPEN')))
  return row?.total != null ? Number(row.total) : 0
}

export async function getBuyingPower(userId: number, tx: Db = db): Promise<number> {
  const [cash, putCollateral, shortCollateral] = await Promise.all([
    getCashBalance(userId, tx),
    reservedPutCollateral(userId, tx),
    reservedShortCollateral(userId, tx),
  ])
  return cash - putCollateral - shortCollateral
}

// Long-source OPEN shares on `ticker` minus contracts*100 already committed to the
// user's other OPEN SELL_CALL posts on that ticker. `ticker` must already be
// uppercased by the caller (matches the uppercase-at-groupby convention in ticker-pnl.ts).
export async function getAvailableShares(userId: number, ticker: string, tx: Db = db): Promise<number> {
  const [ownedRow] = await tx
    .select({ total: sql<string | null>`SUM(${stockHoldings.shares})` })
    .from(stockHoldings)
    .where(and(
      eq(stockHoldings.userId, userId),
      eq(stockHoldings.ticker, ticker),
      eq(stockHoldings.status, 'OPEN'),
      sql`${stockHoldings.shares} > 0`,
    ))
  const [committedRow] = await tx
    .select({ total: sql<string | null>`SUM(${tradePosts.contracts} * 100)` })
    .from(tradePosts)
    .where(and(
      eq(tradePosts.userId, userId),
      eq(tradePosts.ticker, ticker),
      eq(tradePosts.tradeType, 'SELL_CALL'),
      eq(tradePosts.status, 'OPEN'),
    ))
  const owned = ownedRow?.total != null ? Number(ownedRow.total) : 0
  const committed = committedRow?.total != null ? Number(committedRow.total) : 0
  return owned - committed
}
