import { pgTable, text, integer, numeric, bigint, date, timestamp, serial, boolean, primaryKey, index } from 'drizzle-orm/pg-core'
import { createInsertSchema } from 'drizzle-zod'
import { z } from 'zod/v4'

// ── watchlist ─────────────────────────────────────────────────────────────────

export const watchlist = pgTable('watchlist', {
  ticker:  text('ticker').primaryKey(),
  tier:    integer('tier').notNull(),
  status:  text('status').notNull(),  // want_to_own | assigned | monitoring | closed
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  notes:   text('notes'),
})

export const insertWatchlistSchema = createInsertSchema(watchlist).omit({ addedAt: true })
export type InsertWatchlist = z.infer<typeof insertWatchlistSchema>
export type Watchlist = typeof watchlist.$inferSelect

// ── ticker_config ─────────────────────────────────────────────────────────────
// Static per-ticker config — editable without a code deploy.

export const tickerConfig = pgTable('ticker_config', {
  ticker:       text('ticker').primaryKey(),
  tier:         integer('tier').notNull(),
  rsiThreshold: numeric('rsi_threshold').notNull(),
  notes:        text('notes'),
})

export const insertTickerConfigSchema = createInsertSchema(tickerConfig)
export type InsertTickerConfig = z.infer<typeof insertTickerConfigSchema>
export type TickerConfig = typeof tickerConfig.$inferSelect

// ── positions ─────────────────────────────────────────────────────────────────

export const positions = pgTable('positions', {
  id:           serial('id').primaryKey(),
  accountId:    text('account_id').notNull(),
  ticker:       text('ticker').notNull(),
  positionType: text('position_type').notNull(), // short_put | short_call | long_stock | long_call | long_put
  strike:       numeric('strike'),
  expiry:       date('expiry'),
  qty:          integer('qty').notNull(),
  avgPrice:     numeric('avg_price').notNull(),
  openedAt:     timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
  closedAt:     timestamp('closed_at', { withTimezone: true }),
  pnl:          numeric('pnl'),
}, t => ({
  tickerIdx: index('idx_positions_ticker').on(t.ticker),
}))

export const insertPositionSchema = createInsertSchema(positions).omit({ id: true, openedAt: true })
export type InsertPosition = z.infer<typeof insertPositionSchema>
export type Position = typeof positions.$inferSelect

// ── signal_log ────────────────────────────────────────────────────────────────

export const signalLog = pgTable('signal_log', {
  id:            serial('id').primaryKey(),
  ticker:        text('ticker').notNull(),
  firedAt:       timestamp('fired_at', { withTimezone: true }).defaultNow().notNull(),
  rsiAtFire:     numeric('rsi_at_fire'),
  mfiAtFire:     numeric('mfi_at_fire'),
  return5d:      numeric('return_5d'),
  rmResult:      text('rm_result'),   // proceed | check_catalyst | exclude
  catalystFound: text('catalyst_found'),
  strike:        numeric('strike'),
  expiry:        date('expiry'),
  premium:       numeric('premium'),
  incomePct:     numeric('income_pct'),
  vixAtFire:     numeric('vix_at_fire'),
  outcome:       text('outcome'),     // win | loss | assigned | pending
}, t => ({
  tickerIdx: index('idx_signal_log_ticker').on(t.ticker, t.firedAt),
}))

export const insertSignalLogSchema = createInsertSchema(signalLog).omit({ id: true, firedAt: true })
export type InsertSignalLog = z.infer<typeof insertSignalLogSchema>
export type SignalLog = typeof signalLog.$inferSelect

// ── prices_historical ─────────────────────────────────────────────────────────

export const pricesHistorical = pgTable('prices_historical', {
  ticker: text('ticker').notNull(),
  date:   date('date').notNull(),
  open:   numeric('open'),
  high:   numeric('high'),
  low:    numeric('low'),
  close:  numeric('close'),
  volume: bigint('volume', { mode: 'number' }),
}, t => ({
  pk:        primaryKey({ columns: [t.ticker, t.date] }),
  lookupIdx: index('idx_prices_lookup').on(t.ticker, t.date),
}))

export const insertPriceSchema = createInsertSchema(pricesHistorical)
export type InsertPrice = z.infer<typeof insertPriceSchema>
export type PriceRow = typeof pricesHistorical.$inferSelect

// ── indicator_cache ───────────────────────────────────────────────────────────
// One row per (ticker, date). Written by the seed job after market close.
// Layer 1 — "static daily" data that the Technical tab reads instantly.

export const indicatorCache = pgTable('indicator_cache', {
  ticker:       text('ticker').notNull(),
  scoredDate:   date('scored_date').notNull(),
  // Core
  rsi:          numeric('rsi').notNull(),
  mfi:          numeric('mfi').notNull(),
  rsiThreshold: numeric('rsi_threshold').notNull(),
  signal:       text('signal').notNull(),    // GO | WATCH | NO
  // Extended — computed from OHLCV
  atr:          numeric('atr'),
  macdCross:    text('macd_cross'),          // BULLISH_CROSS | BEARISH_CROSS | BULLISH | BEARISH
  stoch:        numeric('stoch'),            // %K last value
  return5d:     numeric('return_5d'),        // 5-day price return %
  // Context — requires SPY + 52w data
  position52w:  numeric('position_52w'),     // 0-100, lower = near 52w low = better
  vsSpy20d:     numeric('vs_spy_20d'),       // negative = relatively weak = better
  // Earnings
  earningsDate: date('earnings_date'),
}, t => ({
  pk: primaryKey({ columns: [t.ticker, t.scoredDate] }),
}))

export const insertIndicatorCacheSchema = createInsertSchema(indicatorCache)
export type InsertIndicatorCache = z.infer<typeof insertIndicatorCacheSchema>
export type IndicatorCacheRow = typeof indicatorCache.$inferSelect
