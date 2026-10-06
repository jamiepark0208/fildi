import type { PortfolioEntry, PositionType } from "@/hooks/use-portfolio";

// Convert Robinhood DB rows → PortfolioEntry for PortfolioAnalysis
export function dbToEntries(
  positions: Array<{ id: number; symbol: string; quantity: string | null; avgCost: string | null; accountNickname: string | null; account: string; marketValue?: string | null; unrealizedPnL?: string | null }>,
  options: Array<{ id: number; symbol: string; direction: string | null; optionType: string | null; qty: string | null; avgPremium: string | null; strike: string | null; expiration: string | null; account: string; markPrice?: string | null; unrealizedPnL?: string | null; delta?: string | null; theta?: string | null; gamma?: string | null; vega?: string | null }>,
  accountMap: Map<string, string>,
): PortfolioEntry[] {
  const posEntries: PortfolioEntry[] = positions.map(p => ({
    id: `rh-pos-${p.id}`,
    ticker: p.symbol,
    positionType: 'stock' as const,
    qty: parseFloat(p.quantity ?? '0'),
    avgPrice: parseFloat(p.avgCost ?? '0'),
    openedAt: new Date().toISOString().slice(0, 10),
    portfolioName: p.accountNickname ?? p.account,
    currentValue: p.marketValue != null ? parseFloat(p.marketValue) : undefined,
    unrealizedPnL: p.unrealizedPnL != null ? parseFloat(p.unrealizedPnL) : undefined,
  }))

  const todayMs = new Date().setHours(0, 0, 0, 0);
  const optEntries: PortfolioEntry[] = options.filter(o => {
    if (!o.expiration) return true;
    return new Date(o.expiration + 'T16:00:00').getTime() >= todayMs;
  }).flatMap(o => {
    const dir = (o.direction ?? 'long').toLowerCase()
    const kind = (o.optionType ?? 'put').toLowerCase()
    const typeMap: Record<string, PositionType> = {
      'short-put': 'short_put', 'short-call': 'short_call',
      'long-put':  'long_put',  'long-call':  'long_call',
    }
    const positionType: PositionType = typeMap[`${dir}-${kind}`] ?? 'short_put'
    const acct = accountMap.get(o.account) ?? o.account
    const qty = Math.abs(parseFloat(o.qty ?? '0'))
    const markPrice = o.markPrice != null ? parseFloat(o.markPrice) : null
    return [{
      id: `rh-opt-${o.id}`,
      ticker: o.symbol,
      positionType,
      qty,
      avgPrice: parseFloat(o.avgPremium ?? '0'),
      strike: o.strike ? parseFloat(o.strike) : undefined,
      expiry: o.expiration ?? undefined,
      openedAt: new Date().toISOString().slice(0, 10),
      portfolioName: acct,
      currentValue: markPrice != null ? markPrice * 100 * qty : undefined,
      unrealizedPnL: o.unrealizedPnL != null ? parseFloat(o.unrealizedPnL) : undefined,
      delta: o.delta != null ? parseFloat(o.delta) : undefined,
      theta: o.theta != null ? parseFloat(o.theta) : undefined,
      gamma: o.gamma != null ? parseFloat(o.gamma) : undefined,
      vega: o.vega != null ? parseFloat(o.vega) : undefined,
    }]
  })

  return [...posEntries, ...optEntries]
}
