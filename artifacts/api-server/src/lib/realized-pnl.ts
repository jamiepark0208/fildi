import type { PortfolioOrder } from '@workspace/db'

function toDate(v: unknown): Date | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v as string)
  return isNaN(d.getTime()) ? null : d
}

export interface RealizedEvent {
  account: string
  symbol: string
  assetType: 'stock' | 'option' | 'dividend'
  direction: 'long' | 'short' | null
  optionType: 'call' | 'put' | null
  qty: number
  pnl: number
  fees: number
  closedAt: string
}

// Realized (closed) P&L only — derived purely from filled orders, no open/unrealized
// positions here. Stock uses FIFO lot matching per account+symbol. Options are grouped
// by contract identity (account+symbol+strike+expiration+side); a group counts as
// "resolved" once its expiration has passed (covers expired-worthless, which never
// generates a close order) or once close qty has fully matched open qty (early close).
// Dividend/cash-bonus rows (orderType 'dividend'/'cash_bonus', from the estimated-data
// migration) are pure cash income with no cost-basis matching — a cash bonus is treated
// as a dividend since it isn't tied to a specific holding either.
export function computeRealizedPnL(orders: PortfolioOrder[]): RealizedEvent[] {
  const events: RealizedEvent[] = []
  const filled = orders.filter(o => o.state === 'filled')

  // ── Dividends + cash bonuses: straight cash income, no lot matching ──────────
  const dividendRows = filled.filter(o => o.orderType === 'dividend' || o.orderType === 'cash_bonus')
  for (const d of dividendRows) {
    events.push({
      account: d.account, symbol: d.symbol ?? '(cash bonus)', assetType: 'dividend',
      direction: null, optionType: null, qty: parseFloat(d.quantity ?? '0'),
      pnl: parseFloat(d.amount ?? '0'), fees: 0,
      closedAt: (toDate(d.createdAt) ?? new Date()).toISOString(),
    })
  }

  // ── Stock: FIFO per account+symbol ─────────────────────────────────────────
  const equity = filled.filter(o => !o.isOption && o.orderType !== 'dividend' && o.orderType !== 'cash_bonus')
    .sort((a, b) => (toDate(a.createdAt)?.getTime() ?? 0) - (toDate(b.createdAt)?.getTime() ?? 0))

  const lots = new Map<string, { qty: number; price: number }[]>()
  for (const o of equity) {
    const key = `${o.account}::${o.symbol}`
    const qty = parseFloat(o.quantity ?? '0')
    const price = parseFloat(o.avgFillPrice ?? '0')
    const fees = parseFloat(o.fees ?? '0')
    if (!qty) continue

    if (o.side === 'buy') {
      if (!lots.has(key)) lots.set(key, [])
      lots.get(key)!.push({ qty, price })
    } else if (o.side === 'sell') {
      const queue = lots.get(key) ?? []
      let remaining = qty
      let grossPnl = 0
      let matchedQty = 0
      while (remaining > 1e-9 && queue.length > 0) {
        const lot = queue[0]
        const consumed = Math.min(lot.qty, remaining)
        grossPnl += (price - lot.price) * consumed
        matchedQty += consumed
        lot.qty -= consumed
        remaining -= consumed
        if (lot.qty <= 1e-9) queue.shift()
      }
      // Sells beyond known lot history (pre-dates captured transactions) have no
      // traceable cost basis — excluded from P&L rather than guessed.
      if (matchedQty > 1e-9) {
        events.push({
          account: o.account, symbol: o.symbol, assetType: 'stock', direction: 'long',
          optionType: null, qty: matchedQty, pnl: grossPnl - fees, fees,
          closedAt: (toDate(o.createdAt) ?? new Date()).toISOString(),
        })
      }
    }
  }

  // ── Options: group by contract identity ─────────────────────────────────────
  const optionOrders = filled.filter(o => o.isOption && o.legEffect && o.legSide)
  const groups = new Map<string, PortfolioOrder[]>()
  for (const o of optionOrders) {
    const key = `${o.account}::${o.symbol}::${o.optionStrike}::${o.optionExpiration}::${o.optionSide}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(o)
  }

  const today = new Date(); today.setHours(0, 0, 0, 0)

  for (const [, group] of groups) {
    const openLeg = group.find(o => o.legEffect === 'open')
    if (!openLeg) continue
    const direction: 'long' | 'short' = openLeg.legSide === 'sell' ? 'short' : 'long'

    let netCash = 0, fees = 0, openQty = 0, closedQty = 0
    let latestAt = toDate(openLeg.createdAt) ?? new Date()
    for (const o of group) {
      const qty = parseFloat(o.quantity ?? '0')
      const premium = parseFloat(o.premium ?? '0')
      fees += parseFloat(o.fees ?? '0')
      const sign = o.legSide === 'sell' ? 1 : -1
      netCash += sign * premium * qty
      if (o.legEffect === 'open') openQty += qty
      else closedQty += qty
      const oAt = toDate(o.createdAt)
      if (oAt && oAt > latestAt) latestAt = oAt
    }

    const expiration = toDate(openLeg.optionExpiration)
    const expired = expiration != null && expiration < today
    const fullyClosed = openQty > 0 && closedQty >= openQty - 1e-9
    if (!expired && !fullyClosed) continue // still open/live — not realized yet

    events.push({
      account: openLeg.account, symbol: openLeg.symbol, assetType: 'option', direction,
      optionType: (openLeg.optionSide as 'call' | 'put' | null) ?? null,
      qty: openQty, pnl: netCash - fees, fees,
      closedAt: latestAt.toISOString(),
    })
  }

  return events.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime())
}
