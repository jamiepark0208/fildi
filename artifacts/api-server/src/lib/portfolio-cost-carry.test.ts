import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carryForwardCost } from './portfolio-cost-carry.js'
import type { ParsedPosition } from './portfolio-parser.js'

const p = (o: Partial<ParsedPosition>): ParsedPosition => ({
  account: '5QU47796', accountNickname: null, symbol: 'OPEN', quantity: '2000', avgCost: '0.0000',
  lastPrice: '2.265', extHoursPrice: null, marketValue: '4530.00', costBasis: '0.00', unrealizedPnL: '4530.00',
  pnlPct: '0.00', dayChangePct: null, bid: null, ask: null, prevClose: null, ...o,
} as ParsedPosition)

test('zero avg cost carried forward when quantity unchanged', () => {
  const r = carryForwardCost([p({})], [{ account: '5QU47796', symbol: 'OPEN', quantity: '2000', avgCost: '4.6300' }])
  assert.equal(r.positions[0]!.avgCost, '4.6300')
  assert.equal(r.positions[0]!.costBasis, '9260.00')
  assert.equal(r.positions[0]!.unrealizedPnL, '-4730.00')
  assert.deepEqual(r.carried, ['5QU47796:OPEN'])
})

test('quantity changed → unknown (null), never 0', () => {
  const r = carryForwardCost([p({})], [{ account: '5QU47796', symbol: 'OPEN', quantity: '1500', avgCost: '4.6300' }])
  assert.equal(r.positions[0]!.avgCost, null)
  assert.equal(r.positions[0]!.unrealizedPnL, null)
  assert.deepEqual(r.unknown, ['5QU47796:OPEN'])
})

test('real avg cost passes through; other account not used', () => {
  const r = carryForwardCost(
    [p({ avgCost: '4.5', costBasis: '9000' }), p({ account: 'X' })],
    [{ account: '5QU47796', symbol: 'OPEN', quantity: '2000', avgCost: '4.63' }],
  )
  assert.equal(r.positions[0]!.avgCost, '4.5')
  assert.equal(r.positions[1]!.avgCost, null)
})
