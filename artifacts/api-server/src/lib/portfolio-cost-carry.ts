/**
 * Robinhood exports sometimes arrive with Avg Cost = 0 (2026-10-06: the MCP positions
 * payload dropped average_buy_price). A zero cost basis makes every holding look like pure
 * profit, so a missing cost is carried forward from the previous snapshot when the share
 * count is unchanged, and otherwise stored as null (unknown), never 0.
 */
import type { ParsedPosition } from './portfolio-parser.js'

export interface PriorCost { account: string | null; symbol: string; quantity: string | null; avgCost: string | null }

const pos = (v: string | null | undefined): number | null => {
  const n = v == null ? NaN : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function carryForwardCost(
  positions: ParsedPosition[],
  prior: PriorCost[],
): { positions: ParsedPosition[]; carried: string[]; unknown: string[] } {
  const key = (a: string | null, s: string) => `${a ?? ''}|${s}`
  const prev = new Map(prior.filter(p => pos(p.avgCost) != null).map(p => [key(p.account, p.symbol), p]))
  const carried: string[] = []
  const unknown: string[] = []
  const out = positions.map(p => {
    if (pos(p.avgCost) != null) return p
    const qty = pos(p.quantity)
    if (qty == null) return p
    const before = prev.get(key(p.account, p.symbol))
    const avg = before && pos(before.quantity) === qty ? pos(before.avgCost) : null
    const label = `${p.account ?? ''}:${p.symbol}`
    if (avg == null) {
      unknown.push(label)
      return { ...p, avgCost: null, costBasis: null, unrealizedPnL: null, pnlPct: null }
    }
    carried.push(label)
    const costBasis = avg * qty
    const mv = Number(p.marketValue)
    const unreal = Number.isFinite(mv) ? mv - costBasis : null
    return {
      ...p,
      avgCost: avg.toFixed(4),
      costBasis: costBasis.toFixed(2),
      unrealizedPnL: unreal == null ? null : unreal.toFixed(2),
      pnlPct: unreal == null ? null : ((unreal / costBasis) * 100).toFixed(2),
    }
  })
  return { positions: out, carried, unknown }
}
