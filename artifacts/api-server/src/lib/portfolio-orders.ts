import { desc, eq } from 'drizzle-orm'
import { db, portfolioOrders, portfolioSnapshots, portfolioAccountSummaries, portfolioPositions, type PortfolioOrder } from '@workspace/db'

// In-memory, single-process cache. This union+dedup is a full-table scan
// (currently ~5.8k raw rows / ~30ms) that the snapshot route re-ran on
// EVERY page load with no caching at all — fine today, but the table grows
// ~daily via the collection pipeline with no upper bound, and nothing was
// stopping a burst of near-simultaneous requests (route load + any refetch)
// from each re-running the full scan+dedup independently. A short TTL
// absorbs that without meaningfully delaying visibility of a fresh daily
// ingest (which lands once/day, not every 60s).
const CACHE_TTL_MS = 60_000
let cache: { computedAt: number; orders: PortfolioOrder[] } | null = null

/**
 * Every order ever collected, across ALL snapshots, deduped by order_id
 * (keeping the highest-id/most-recently-ingested row per id). See
 * portfolio-snapshot.ts for why: any single snapshot's orders only cover
 * whatever ~200-row window that day's collection reached, so scoping to one
 * snapshot silently drops history outside that window. This union only ever
 * grows. Shared between the snapshot route (realized P&L input) and the
 * IV-rank backtest (needs the raw open legs directly).
 */
export async function getMergedOrders(): Promise<PortfolioOrder[]> {
  if (cache && Date.now() - cache.computedAt < CACHE_TTL_MS) return cache.orders

  const allOrders = await db.select().from(portfolioOrders).orderBy(portfolioOrders.id)
  const bestByOrderId = new Map<string, PortfolioOrder>()
  for (const o of allOrders) {
    if (!o.orderId) continue
    bestByOrderId.set(o.orderId, o)
  }
  const orders = [...bestByOrderId.values()]
  cache = { computedAt: Date.now(), orders }
  return orders
}

/**
 * Raw Robinhood account id -> export nickname ("FILDI"/"IRA"). Orders carry
 * the raw id; transactions carry the nickname directly — anything comparing
 * accounts across both sources needs this to canonicalize first (omitting it
 * silently breaks the comparison, since the raw id never matches a nickname —
 * see realized-pnl.ts's canonicalAccount for the bug this caused once already).
 */
export async function getAccountNickMap(): Promise<Map<string, string>> {
  const [snapshot] = await db.select().from(portfolioSnapshots).orderBy(desc(portfolioSnapshots.importedAt)).limit(1)
  const m = new Map<string, string>()
  if (!snapshot) return m
  const [accountSummaries, positions] = await Promise.all([
    db.select().from(portfolioAccountSummaries).where(eq(portfolioAccountSummaries.snapshotId, snapshot.id)),
    db.select().from(portfolioPositions).where(eq(portfolioPositions.snapshotId, snapshot.id)),
  ])
  for (const a of accountSummaries) {
    const nick = a.nickname ?? a.account
    m.set(a.account, nick === 'Traditional IRA' ? 'IRA' : nick)
  }
  for (const p of positions) {
    if (p.accountNickname && !m.has(p.account)) {
      m.set(p.account, p.accountNickname === 'Traditional IRA' ? 'IRA' : p.accountNickname)
    }
  }
  return m
}
