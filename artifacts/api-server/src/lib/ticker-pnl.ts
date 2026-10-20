export interface TickerPnlRollup {
  ticker: string
  realizedPnl: number
  unrealizedPnl: number
  totalPnl: number
}

interface PostLike { ticker: string; status: string; resolvedPnl: number | null }
interface HoldingLike { ticker: string; status: string; realizedPnl: number | null; unrealizedPnl: number | null }

// Combines realized P&L from closed/expired trade_posts with realized (CALLED_AWAY/
// CLOSED) and unrealized (OPEN) P&L from stock_holdings, grouped per ticker. Tickers
// are normalized to uppercase here since trade_posts.ticker and stock_holdings.ticker
// aren't guaranteed to match casing without it.
export function computeTickerPnlRollup(posts: PostLike[], holdings: HoldingLike[]): TickerPnlRollup[] {
  const map = new Map<string, { realized: number; unrealized: number }>()
  const bump = (ticker: string, realized: number, unrealized: number) => {
    const key = ticker.toUpperCase()
    const entry = map.get(key) ?? { realized: 0, unrealized: 0 }
    entry.realized += realized
    entry.unrealized += unrealized
    map.set(key, entry)
  }

  for (const p of posts) {
    if (p.status !== 'OPEN' && p.resolvedPnl != null) bump(p.ticker, p.resolvedPnl, 0)
  }
  for (const h of holdings) {
    if ((h.status === 'CALLED_AWAY' || h.status === 'CLOSED') && h.realizedPnl != null) bump(h.ticker, h.realizedPnl, 0)
    if (h.status === 'OPEN' && h.unrealizedPnl != null) bump(h.ticker, 0, h.unrealizedPnl)
  }

  return [...map.entries()]
    .map(([ticker, v]) => ({
      ticker,
      realizedPnl:   v.realized,
      unrealizedPnl: v.unrealized,
      totalPnl:      v.realized + v.unrealized,
    }))
    // Drop pure-zero rows so Top Tickers empties after a stats reset.
    .filter((r) => Math.abs(r.totalPnl) >= 0.005)
}
