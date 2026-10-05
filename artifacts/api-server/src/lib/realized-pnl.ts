import type { PortfolioOrder, PortfolioTransaction } from '@workspace/db'

function toDate(v: unknown): Date | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v as string)
  return isNaN(d.getTime()) ? null : d
}

function num(v: string | null | undefined): number {
  if (v == null || v === '') return 0
  const n = parseFloat(v)
  return Number.isFinite(n) ? n : 0
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

/** Assignment buy with no matching sell, while shares are no longer in holdings. */
export interface OrphanedStockLot {
  account: string
  symbol: string
  qty: number
  costBasis: number
  avgCost: number
  openedAt: string
}

export interface RealizedPnLResult {
  events: RealizedEvent[]
  orphanedStockLots: OrphanedStockLot[]
}

type Lot = { qty: number; price: number; openedAt: string }

function pushBuy(lots: Map<string, Lot[]>, key: string, qty: number, price: number, openedAt: string) {
  if (qty <= 0 || price <= 0) return
  if (!lots.has(key)) lots.set(key, [])
  lots.get(key)!.push({ qty, price, openedAt })
}

function matchSell(
  lots: Map<string, Lot[]>,
  key: string,
  qty: number,
  price: number,
  fees: number,
  closedAt: string,
  account: string,
  symbol: string,
): RealizedEvent | null {
  if (qty <= 0 || price <= 0) return null
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
  // Sells beyond known lot history have no traceable cost basis — skip.
  if (matchedQty <= 1e-9) return null
  return {
    account, symbol, assetType: 'stock', direction: 'long',
    optionType: null, qty: matchedQty, pnl: grossPnl - fees, fees, closedAt,
  }
}

/**
 * Stock FIFO from the flat transactions export. Covers put-assignment buys and
 * call-assignment (called-away) sells that never appear in the equity-orders API.
 * Account is the export nickname ("FILDI" / "IRA"), not the Robinhood account id.
 */
function stockEventsFromTransactions(txns: PortfolioTransaction[]): {
  events: RealizedEvent[]
  openLots: Map<string, Lot[]>
} {
  const events: RealizedEvent[] = []
  const lots = new Map<string, Lot[]>()

  const stockRows = txns
    .filter(t => {
      const tt = t.txnType ?? ''
      return tt === 'assignment_buy' || tt === 'assignment_sell' || tt === 'equity_order'
    })
    .sort((a, b) => (toDate(a.txnDate)?.getTime() ?? 0) - (toDate(b.txnDate)?.getTime() ?? 0))

  for (const t of stockRows) {
    const qty = num(t.quantity)
    const price = num(t.price)
    const side = (t.side ?? '').toLowerCase()
    const tt = t.txnType ?? ''
    const closedAt = (toDate(t.txnDate) ?? new Date()).toISOString()
    const key = `${t.account}::${t.symbol}`

    const isBuy = tt === 'assignment_buy' || (tt === 'equity_order' && side === 'buy')
    const isSell = tt === 'assignment_sell' || (tt === 'equity_order' && side === 'sell')

    if (isBuy) {
      pushBuy(lots, key, qty, price, closedAt)
    } else if (isSell) {
      const ev = matchSell(lots, key, qty, price, 0, closedAt, t.account, t.symbol)
      if (ev) events.push(ev)
    }
  }

  return { events, openLots: lots }
}

function stockEventsFromOrders(orders: PortfolioOrder[]): RealizedEvent[] {
  const events: RealizedEvent[] = []
  const filled = orders.filter(o => o.state === 'filled')
  const equity = filled
    .filter(o => !o.isOption && o.orderType !== 'dividend' && o.orderType !== 'cash_bonus')
    .sort((a, b) => (toDate(a.createdAt)?.getTime() ?? 0) - (toDate(b.createdAt)?.getTime() ?? 0))

  const lots = new Map<string, Lot[]>()
  for (const o of equity) {
    const key = `${o.account}::${o.symbol}`
    const qty = num(o.quantity)
    const price = num(o.avgFillPrice)
    const fees = num(o.fees)
    if (!qty) continue
    const closedAt = (toDate(o.createdAt) ?? new Date()).toISOString()

    if (o.side === 'buy') {
      pushBuy(lots, key, qty, price, closedAt)
    } else if (o.side === 'sell') {
      const ev = matchSell(lots, key, qty, price, fees, closedAt, o.account, o.symbol)
      if (ev) events.push(ev)
    }
  }
  return events
}

/**
 * `portfolio_transactions` rows with txnType 'realized_close' are Robinhood's
 * OWN computed per-trade realized gain (sourced from get_pnl_trade_history,
 * carrying whatever cost-basis/lot-selection method the account actually
 * uses) rather than a reconstruction from raw orders. Verified 2026-10-03
 * against Robinhood's own get_realized_pnl: these sum to within ~$30-50 of
 * the account's true YTD total, vs. several-thousand-dollar gaps from
 * rebuilding P&L via FIFO over raw orders (even after fixing the cycle-
 * pairing bug below) — Robinhood's real lot selection isn't pure chronological
 * FIFO, so a from-scratch reconstruction has a structural ceiling on accuracy
 * that this data source doesn't. Prefer it wherever available.
 */
function eventsFromRealizedCloseTxns(txns: PortfolioTransaction[]): RealizedEvent[] {
  const events: RealizedEvent[] = []
  for (const t of txns) {
    if (t.txnType !== 'realized_close') continue
    const category = t.category ?? ''
    const isStock = category.startsWith('Stocks')
    const assetType: RealizedEvent['assetType'] = isStock ? 'stock' : 'option'
    const direction: RealizedEvent['direction'] = isStock
      ? 'long'
      : category.startsWith('Sell') ? 'short' : category.startsWith('Long') ? 'long' : null
    const optionType: RealizedEvent['optionType'] = category.includes('Call')
      ? 'call' : category.includes('Put') ? 'put' : null
    events.push({
      account: t.account, symbol: t.symbol, assetType, direction, optionType,
      qty: num(t.quantity), pnl: num(t.amount), fees: 0,
      closedAt: (toDate(t.txnDate) ?? new Date()).toISOString(),
    })
  }
  return events
}

/**
 * Realized (closed) P&L. Prefers Robinhood's own per-trade realized-close
 * records (see eventsFromRealizedCloseTxns) for both stock and options, PER
 * ACCOUNT, for whatever date range each account's realized_close data
 * actually covers (gap-filled, not all-or-nothing — see
 * earliestClosedAtByAccount below; an account can have realized_close
 * starting mid-history, and dates before that still need the fallback).
 * Stock otherwise prefers the flat transactions export (assignments + equity
 * orders) — assignment buys/sells never show up in Robinhood's equity-orders
 * API. Falls back to order-book FIFO when neither exists. Options otherwise
 * match from filled option orders (open/close/expiry).
 */
export function computeRealizedPnL(
  orders: PortfolioOrder[],
  transactions: PortfolioTransaction[] = [],
  heldKeys: Set<string> = new Set(),
  // Raw Robinhood account id -> export nickname ("FILDI"/"IRA"). Orders carry
  // the raw id; transactions (and therefore realized_close) carry the
  // nickname directly — this function's gap-fill logic below compares
  // coverage across both sources, so it MUST canonicalize to one namespace
  // first. Omitting this silently breaks that comparison (every fifo event's
  // canonicalAccount(e.account) call falls back to the raw id unchanged,
  // which then never matches a nickname-keyed coverage-start entry — found
  // and fixed 2026-10-03: it was doubling every option event that already
  // had realized_close coverage, since the gap-fill filter always saw
  // coverageStart as undefined and let everything through).
  accountNickMap: Map<string, string> = new Map(),
): RealizedPnLResult {
  const canonicalAccount = (raw: string): string => accountNickMap.get(raw) ?? raw
  const events: RealizedEvent[] = []
  const filled = orders.filter(o => o.state === 'filled')

  // ── Dividends + cash bonuses from orders ───────────────────────────────────
  const dividendRows = filled.filter(o => o.orderType === 'dividend' || o.orderType === 'cash_bonus')
  for (const d of dividendRows) {
    events.push({
      account: d.account, symbol: d.symbol ?? '(cash bonus)', assetType: 'dividend',
      direction: null, optionType: null, qty: num(d.quantity),
      pnl: num(d.amount), fees: 0,
      closedAt: (toDate(d.createdAt) ?? new Date()).toISOString(),
    })
  }

  // Dividends from flat transactions only when orders didn't already carry them
  // (avoids double-counting after the estimated-data migration put dividends in both).
  if (dividendRows.length === 0) {
    for (const t of transactions) {
      if (t.txnType !== 'dividend' && t.txnType !== 'cash_bonus') continue
      events.push({
        account: t.account, symbol: t.symbol || '(cash bonus)', assetType: 'dividend',
        direction: null, optionType: null, qty: num(t.quantity),
        pnl: num(t.amount), fees: 0,
        closedAt: (toDate(t.txnDate) ?? new Date()).toISOString(),
      })
    }
  }

  const realizedCloseEvents = eventsFromRealizedCloseTxns(transactions)
  const realizedCloseStock = realizedCloseEvents.filter(e => e.assetType === 'stock')
  const realizedCloseOptions = realizedCloseEvents.filter(e => e.assetType === 'option')

  // realized_close coverage starts on whatever date Robinhood's trade-history
  // bootstrap first ran per account (confirmed 2026-10-03: Feb 20 2026 for
  // both accounts here, for stock) — it is NOT a full-history backfill.
  // Preferring it unconditionally once ANY row exists silently dropped
  // everything before that date (confirmed: FILDI has 32 real equity sells
  // from 2019, which vanished from the total the first time this preference
  // shipped). Fix: gap-fill per account — realized_close for whatever it
  // covers, FIFO/order reconstruction only for the span before that.
  //
  // The naive version of that fix (single earliest realized_close date as a
  // hard boundary) then double-counted a different way: realized_close's OWN
  // early coverage isn't contiguous — confirmed 2026-10-03 for IRA options, a
  // lone bootstrap row on Feb 10 sits ahead of where dense coverage actually
  // starts (Feb 13+), so the boundary computed from "earliest row" sat INSIDE
  // a gap, and FIFO gap-fill reconstructed a near-duplicate of the real Feb
  // 13 HOOD trade from 4 days earlier (same $465, different order timestamp).
  // Fix: apply a safety buffer — only gap-fill events closing more than
  // COVERAGE_BOUNDARY_BUFFER_DAYS before the earliest known realized_close
  // date, accepting a small under-count risk in that narrow buffer window
  // (days, not months) as far preferable to a double-count.
  const COVERAGE_BOUNDARY_BUFFER_DAYS = 14
  function earliestClosedAtByAccount(evs: RealizedEvent[]): Map<string, string> {
    const m = new Map<string, string>()
    for (const e of evs) {
      const acct = canonicalAccount(e.account)
      const existing = m.get(acct)
      if (!existing || e.closedAt < existing) m.set(acct, e.closedAt)
    }
    return m
  }
  function bufferedCutoff(coverageStart: string | undefined): string | null {
    if (coverageStart == null) return null
    return new Date(new Date(coverageStart).getTime() - COVERAGE_BOUNDARY_BUFFER_DAYS * 86_400_000).toISOString()
  }

  // ── Stock ──────────────────────────────────────────────────────────────────
  // fromTxns.openLots still needed below for orphan-lot detection regardless
  // of which realized-events source wins (that's about currently-open stale
  // assignment lots, not about which events get reported as realized).
  const fromTxns = stockEventsFromTransactions(transactions)
  const stockCoverageStart = earliestClosedAtByAccount(realizedCloseStock)
  const stockGapFill = fromTxns.events.filter(e => {
    const cutoff = bufferedCutoff(stockCoverageStart.get(canonicalAccount(e.account)))
    return cutoff == null || e.closedAt < cutoff
  })
  if (realizedCloseStock.length > 0 || fromTxns.events.length > 0 || fromTxns.openLots.size > 0) {
    events.push(...realizedCloseStock, ...stockGapFill)
  } else {
    events.push(...stockEventsFromOrders(orders))
  }

  // ── Options ──────────────────────────────────────────────────────────────
  // Same gap-fill as stock above: realized_close for whatever span it covers
  // per account, FIFO cycle reconstruction (below) only fills in before that.
  const optionCoverageStart = earliestClosedAtByAccount(realizedCloseOptions)
  const fifoOptionEvents: RealizedEvent[] = []
  {
  // Group by contract identity, then split into independent open→close
  // CYCLES within each group ──────────────────────────────────────
  // A single (account, symbol, strike, expiration, side) key can legitimately
  // be traded multiple separate times before expiry — e.g. wheeling the same
  // weekly strike: sell, buy-to-close, sell again same day/week. Those are
  // independent round trips with independent P&L, not one blob. The old
  // version summed every order under a key into one event using only the
  // FIRST open leg ever seen — once a cycle fully closed and a brand new
  // cycle opened under the same key, its premiums/fees got silently merged
  // into the first cycle's math, understating total realized P&L (confirmed
  // 2026-10-03: this app's own total ran ~2x below Robinhood's own
  // get_realized_pnl figure for the same account/window). Fix: walk each
  // group chronologically, start a fresh accumulator on an 'open' leg only
  // when no cycle is currently active, and close out + emit an event the
  // moment that cycle's closed qty catches up to its open qty. (This whole
  // branch is now a fallback — realizedCloseOptions above is the accurate
  // path — but kept correct in its own right for periods with no
  // realized-close coverage.)
  const optionOrders = filled.filter(o => o.isOption && o.legEffect && o.legSide)
  const groups = new Map<string, PortfolioOrder[]>()
  for (const o of optionOrders) {
    const key = `${o.account}::${o.symbol}::${o.optionStrike}::${o.optionExpiration}::${o.optionSide}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(o)
  }

  const today = new Date(); today.setHours(0, 0, 0, 0)

  type Cycle = {
    account: string; symbol: string; optionSide: string | null; direction: 'long' | 'short'
    netCash: number; fees: number; openQty: number; closedQty: number; latestAt: Date
  }
  const emitCycle = (c: Cycle) => {
    fifoOptionEvents.push({
      account: c.account, symbol: c.symbol, assetType: 'option', direction: c.direction,
      optionType: (c.optionSide as 'call' | 'put' | null) ?? null,
      qty: c.openQty, pnl: c.netCash - c.fees, fees: c.fees,
      closedAt: c.latestAt.toISOString(),
    })
  }

  for (const [, group] of groups) {
    const sorted = [...group].sort((a, b) => (toDate(a.createdAt)?.getTime() ?? 0) - (toDate(b.createdAt)?.getTime() ?? 0))
    const expiration = toDate(sorted[0]?.optionExpiration)
    const expired = expiration != null && expiration < today

    let cycle: Cycle | null = null
    for (const o of sorted) {
      if (o.legEffect === 'open' && !cycle) {
        cycle = {
          account: o.account, symbol: o.symbol, optionSide: o.optionSide,
          direction: o.legSide === 'sell' ? 'short' : 'long',
          netCash: 0, fees: 0, openQty: 0, closedQty: 0,
          latestAt: toDate(o.createdAt) ?? new Date(),
        }
      }
      if (!cycle) continue // a close with no active cycle (open leg outside our data) — skip

      const qty = num(o.quantity)
      const premium = num(o.premium)
      cycle.fees += num(o.fees)
      const sign = o.legSide === 'sell' ? 1 : -1
      cycle.netCash += sign * premium * qty
      if (o.legEffect === 'open') cycle.openQty += qty
      else cycle.closedQty += qty
      const oAt = toDate(o.createdAt)
      if (oAt && oAt > cycle.latestAt) cycle.latestAt = oAt

      if (cycle.openQty > 0 && cycle.closedQty >= cycle.openQty - 1e-9) {
        emitCycle(cycle)
        cycle = null // ready for a possible later re-open under the same key
      }
    }
    // Leftover still-open cycle: only realized if the contract has since
    // expired (worthless or assigned) — otherwise it's genuinely still open.
    if (cycle && expired) emitCycle(cycle)
  }
  }

  const optionGapFill = fifoOptionEvents.filter(e => {
    const cutoff = bufferedCutoff(optionCoverageStart.get(canonicalAccount(e.account)))
    return cutoff == null || e.closedAt < cutoff
  })
  events.push(...realizedCloseOptions, ...optionGapFill)

  // Orphan lots: assignment/equity buys still open in txn FIFO, but shares are
  // gone from the latest holdings snapshot — usually a missing assignment_sell
  // (called-away) that the RH export never recorded.
  const orphanedStockLots: OrphanedStockLot[] = []
  for (const [key, queue] of fromTxns.openLots) {
    const remaining = queue.reduce((s, l) => s + l.qty, 0)
    if (remaining <= 1e-9) continue
    if (heldKeys.has(key)) continue
    const [account, symbol] = key.split('::')
    const costBasis = queue.reduce((s, l) => s + l.qty * l.price, 0)
    const openedAt = queue[0]?.openedAt ?? new Date().toISOString()
    orphanedStockLots.push({
      account, symbol, qty: remaining, costBasis,
      avgCost: remaining > 0 ? costBasis / remaining : 0,
      openedAt,
    })
  }

  return {
    events: events.sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime()),
    orphanedStockLots,
  }
}
