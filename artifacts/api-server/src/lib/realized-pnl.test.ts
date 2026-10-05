import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeRealizedPnL } from './realized-pnl.js'
import type { PortfolioOrder, PortfolioTransaction } from '@workspace/db'

function txn(partial: Partial<PortfolioTransaction> & Pick<PortfolioTransaction, 'txnId' | 'account' | 'symbol'>): PortfolioTransaction {
  return {
    id: 0,
    txnType: null,
    category: null,
    side: null,
    quantity: null,
    price: null,
    amount: null,
    txnDate: null,
    source: null,
    confidence: null,
    importedAt: new Date(),
    ...partial,
  }
}

function order(partial: Partial<PortfolioOrder> & Pick<PortfolioOrder, 'account' | 'symbol'>): PortfolioOrder {
  return {
    id: 0,
    snapshotId: 1,
    orderId: null,
    side: null,
    orderType: null,
    state: 'filled',
    quantity: null,
    cumulativeQty: null,
    processedQty: null,
    canceledQty: null,
    limitPrice: null,
    stopPrice: null,
    avgFillPrice: null,
    premium: null,
    processedPremium: null,
    fees: null,
    timeInForce: null,
    marketHours: null,
    placedAgent: null,
    createdAt: null,
    lastTransactionAt: null,
    isOption: false,
    optionStrike: null,
    optionExpiration: null,
    optionSide: null,
    legSide: null,
    legEffect: null,
    amount: null,
    source: null,
    confidence: null,
    ...partial,
  }
}

describe('computeRealizedPnL', () => {
  it('realizes stock capital gains from assignment buy → assignment sell', () => {
    const txns = [
      txn({
        txnId: 'a1', account: 'IRA', symbol: 'HOOD', txnType: 'assignment_buy',
        side: 'buy', quantity: '100', price: '74.84',
        txnDate: new Date('2026-02-13'),
      }),
      txn({
        txnId: 'a2', account: 'IRA', symbol: 'HOOD', txnType: 'assignment_sell',
        side: 'sell', quantity: '100', price: '111.4194',
        txnDate: new Date('2026-07-02'),
      }),
    ]
    const { events, orphanedStockLots } = computeRealizedPnL([], txns)
    const stock = events.filter(e => e.assetType === 'stock')
    assert.equal(stock.length, 1)
    assert.ok(Math.abs(stock[0].pnl - (111.4194 - 74.84) * 100) < 0.02)
    assert.equal(orphanedStockLots.length, 0)
  })

  it('flags orphaned assignment lots when shares left holdings without a sell', () => {
    const txns = [
      txn({
        txnId: 'pltr1', account: 'IRA', symbol: 'PLTR', txnType: 'assignment_buy',
        side: 'buy', quantity: '100', price: '128.09',
        txnDate: new Date('2026-06-12'),
      }),
    ]
    const { events, orphanedStockLots } = computeRealizedPnL([], txns, new Set())
    assert.equal(events.filter(e => e.assetType === 'stock').length, 0)
    assert.equal(orphanedStockLots.length, 1)
    assert.equal(orphanedStockLots[0].symbol, 'PLTR')
    assert.equal(orphanedStockLots[0].qty, 100)
    assert.ok(Math.abs(orphanedStockLots[0].avgCost - 128.09) < 0.01)

    const held = computeRealizedPnL([], txns, new Set(['IRA::PLTR']))
    assert.equal(held.orphanedStockLots.length, 0)
  })

  it('still matches option open/close from orders', () => {
    const orders = [
      order({
        account: '5QU', symbol: 'AAPL', isOption: true, state: 'filled',
        quantity: '1', premium: '1.00', legSide: 'sell', legEffect: 'open',
        optionSide: 'put', optionStrike: '100', optionExpiration: '2026-01-01',
        createdAt: new Date('2025-12-20'),
      }),
      order({
        account: '5QU', symbol: 'AAPL', isOption: true, state: 'filled',
        quantity: '1', premium: '0.20', legSide: 'buy', legEffect: 'close',
        optionSide: 'put', optionStrike: '100', optionExpiration: '2026-01-01',
        createdAt: new Date('2025-12-28'),
      }),
    ]
    const { events } = computeRealizedPnL(orders, [])
    const opts = events.filter(e => e.assetType === 'option')
    assert.equal(opts.length, 1)
    assert.equal(opts[0].direction, 'short')
    assert.ok(Math.abs(opts[0].pnl - 0.8) < 1e-9)
  })
})
