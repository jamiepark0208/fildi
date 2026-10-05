/**
 * CLI counterpart to artifacts/api-server/src/routes/portfolio-ingest.ts —
 * same detection/parsing/insert logic, but reads a file path and writes to
 * Postgres directly instead of going through the HTTP route (which requires
 * a logged-in admin session cookie). For local automation only: never
 * expose this as a network-facing command.
 *
 * Usage: tsx scripts/ingest-portfolio-csv.mts <path-to-csv> [...more paths]
 */
import { readFileSync } from 'fs'
import {
  db,
  portfolioSnapshots,
  portfolioAccountSummaries,
  portfolioPositions,
  portfolioEquityFundamentals,
  portfolioOptions,
  portfolioOrders,
  portfolioTransactions,
  portfolioTickerEarnings,
  pool,
} from '@workspace/db'
import { parseRobinhoodCSV } from '../artifacts/api-server/src/lib/portfolio-parser.js'
import {
  isTransactionsCSV,
  isTickerEarningsCSV,
  parseTransactionsCSV,
  parseTickerEarningsCSV,
} from '../artifacts/api-server/src/lib/portfolio-txn-parser.js'

async function ingestOne(filePath: string): Promise<void> {
  const csvText = readFileSync(filePath, 'utf8')

  if (!csvText || csvText.trim().length === 0) {
    console.error(`SKIP ${filePath}: empty file`)
    return
  }

  if (isTransactionsCSV(csvText)) {
    const txns = parseTransactionsCSV(csvText)
    let inserted = 0
    for (const t of txns) {
      const result = await db
        .insert(portfolioTransactions)
        .values({
          txnId:      t.txnId,
          account:    t.account,
          symbol:     t.symbol,
          txnType:    t.txnType,
          category:   t.category,
          side:       t.side,
          quantity:   t.quantity,
          price:      t.price,
          amount:     t.amount,
          txnDate:    t.txnDate ? new Date(t.txnDate) : null,
          source:     t.source,
          confidence: t.confidence,
        })
        .onConflictDoNothing({ target: portfolioTransactions.txnId })
        .returning({ id: portfolioTransactions.id })
      if (result.length > 0) inserted++
    }
    console.log(`${filePath}: transactions — ${txns.length} rows, ${inserted} inserted, ${txns.length - inserted} skipped (dup)`)
    return
  }

  if (isTickerEarningsCSV(csvText)) {
    const rows = parseTickerEarningsCSV(csvText)
    for (const r of rows) {
      await db
        .insert(portfolioTickerEarnings)
        .values({
          account:          r.account,
          ticker:           r.ticker,
          totalUnrealized:  r.totalUnrealized,
          totalRealized:    r.totalRealized,
          totalEarned:      r.totalEarned,
          sellPut:          r.sellPut,
          sellCall:         r.sellCall,
          longCall:         r.longCall,
          longPut:          r.longPut,
          dividends:        r.dividends,
          stocksRealized:   r.stocksRealized,
          stocksUnrealized: r.stocksUnrealized,
          totalStocks:      r.totalStocks,
          importedAt:       new Date(),
        })
        .onConflictDoUpdate({
          target: [portfolioTickerEarnings.account, portfolioTickerEarnings.ticker],
          set: {
            totalUnrealized:  r.totalUnrealized,
            totalRealized:    r.totalRealized,
            totalEarned:      r.totalEarned,
            sellPut:          r.sellPut,
            sellCall:         r.sellCall,
            longCall:         r.longCall,
            longPut:          r.longPut,
            dividends:        r.dividends,
            stocksRealized:   r.stocksRealized,
            stocksUnrealized: r.stocksUnrealized,
            totalStocks:      r.totalStocks,
            importedAt:       new Date(),
          },
        })
    }
    console.log(`${filePath}: ticker earnings — ${rows.length} rows upserted`)
    return
  }

  const parsed = parseRobinhoodCSV(csvText)

  const [snapshot] = await db
    .insert(portfolioSnapshots)
    .values({
      accountIds:  parsed.accountIds,
      totalValue:  parsed.totalValue != null ? String(parsed.totalValue) : null,
      cashBalance: parsed.cashBalance != null ? String(parsed.cashBalance) : null,
      cryptoValue: parsed.cryptoValue != null ? String(parsed.cryptoValue) : null,
      rawFilename: filePath.split('/').pop() ?? null,
    })
    .returning({ id: portfolioSnapshots.id })

  const snapshotId = snapshot.id

  if (parsed.accountSummaries.length > 0) {
    await db.insert(portfolioAccountSummaries).values(
      parsed.accountSummaries.map(a => ({
        snapshotId,
        account:        a.account,
        nickname:       a.nickname,
        type:           a.type,
        totalValue:     a.totalValue,
        equityValue:    a.equityValue,
        optionsValue:   a.optionsValue,
        cryptoValue:    a.cryptoValue,
        eventContracts: a.eventContracts,
        cash:           a.cash,
        marginUsed:     a.marginUsed,
        buyingPower:    a.buyingPower,
        unleveragedBp:  a.unleveragedBp,
      }))
    )
  }

  if (parsed.positions.length > 0) {
    await db.insert(portfolioPositions).values(
      parsed.positions.map(p => ({
        snapshotId,
        account:         p.account,
        accountNickname: p.accountNickname ?? null,
        symbol:          p.symbol,
        quantity:        p.quantity,
        avgCost:         p.avgCost,
        lastPrice:       p.lastPrice,
        extHoursPrice:   p.extHoursPrice,
        marketValue:     p.marketValue,
        costBasis:       p.costBasis,
        unrealizedPnL:   p.unrealizedPnL,
        pnlPct:          p.pnlPct,
        dayChangePct:    p.dayChangePct,
        bid:             p.bid,
        ask:             p.ask,
        prevClose:       p.prevClose,
      }))
    )
  }

  if (parsed.equityFundamentals.length > 0) {
    await db.insert(portfolioEquityFundamentals).values(
      parsed.equityFundamentals.map(f => ({
        snapshotId,
        symbol:            f.symbol,
        open:              f.open,
        high:              f.high,
        low:               f.low,
        volume:            f.volume,
        avgVol2w:          f.avgVol2w,
        marketCap:         f.marketCap,
        peRatio:           f.peRatio,
        pbRatio:           f.pbRatio,
        week52High:        f.week52High,
        week52Low:         f.week52Low,
        sharesOutstanding: f.sharesOutstanding,
        divPerShare:       f.divPerShare,
        divYield:          f.divYield,
        sector:            f.sector,
        industry:          f.industry,
      }))
    )
  }

  if (parsed.options.length > 0) {
    await db.insert(portfolioOptions).values(
      parsed.options.map(o => ({
        snapshotId,
        account:       o.account,
        symbol:        o.symbol,
        optionType:    o.optionType,
        strike:        o.strike,
        expiration:    o.expiration,
        direction:     o.direction,
        qty:           o.qty,
        avgPremium:    o.avgPremium,
        totalPremium:  o.totalPremium,
        markPrice:     o.markPrice,
        adjMark:       o.adjMark,
        currentValue:  o.currentValue,
        unrealizedPnL: o.unrealizedPnL,
        pnlPct:        o.pnlPct,
        bid:           o.bid,
        ask:           o.ask,
        prevClose:     o.prevClose,
        iv:            o.iv,
        delta:         o.delta,
        gamma:         o.gamma,
        theta:         o.theta,
        vega:          o.vega,
        openInterest:  o.openInterest,
        volume:        o.volume,
      }))
    )
  }

  if (parsed.orders.length > 0) {
    await db.insert(portfolioOrders).values(
      parsed.orders.map(ord => ({
        snapshotId,
        orderId:           ord.orderId,
        account:           ord.account,
        symbol:            ord.symbol,
        side:              ord.side,
        orderType:         ord.orderType,
        state:             ord.state,
        quantity:          ord.quantity,
        cumulativeQty:     ord.cumulativeQty,
        processedQty:      ord.processedQty,
        canceledQty:       ord.canceledQty,
        limitPrice:        ord.limitPrice,
        stopPrice:         ord.stopPrice,
        avgFillPrice:      ord.avgFillPrice,
        premium:           ord.premium,
        processedPremium:  ord.processedPremium,
        fees:              ord.fees,
        timeInForce:       ord.timeInForce,
        marketHours:       ord.marketHours,
        placedAgent:       ord.placedAgent,
        createdAt:         ord.createdAt ? new Date(ord.createdAt) : null,
        lastTransactionAt: ord.lastTransactionAt ? new Date(ord.lastTransactionAt) : null,
        isOption:          ord.isOption,
        optionStrike:      ord.optionStrike,
        optionExpiration:  ord.optionExpiration,
        optionSide:        ord.optionSide,
        legSide:           ord.legSide,
        legEffect:         ord.legEffect,
      }))
    )
  }

  console.log(`${filePath}: holdings — snapshot ${snapshotId}, ${parsed.positions.length} positions, ${parsed.options.length} options, ${parsed.orders.length} orders`)
}

const paths = process.argv.slice(2)
if (paths.length === 0) {
  console.error('Usage: tsx scripts/ingest-portfolio-csv.mts <path-to-csv> [...more paths]')
  process.exit(1)
}

for (const p of paths) {
  await ingestOne(p)
}
await pool.end()
