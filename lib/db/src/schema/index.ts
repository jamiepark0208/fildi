import { pgTable, text, integer, numeric, bigint, date, timestamp, serial, boolean, primaryKey, index } from 'drizzle-orm/pg-core'
import { createInsertSchema } from 'drizzle-zod'
import { z } from 'zod/v4'

// ── users ─────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id:           serial('id').primaryKey(),
  email:        text('email').notNull().unique(),
  username:     text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role:         text('role').notNull().default('member'), // 'admin' | 'member'
  avatarUrl:    text('avatar_url'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const insertUserSchema = createInsertSchema(users).omit({ id: true, createdAt: true })
export type InsertUser = z.infer<typeof insertUserSchema>
export type User = typeof users.$inferSelect

// ── invite_codes ──────────────────────────────────────────────────────────────

export const inviteCodes = pgTable('invite_codes', {
  code:      text('code').primaryKey(),
  createdBy: integer('created_by').notNull().references(() => users.id),
  usedBy:    integer('used_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  usedAt:    timestamp('used_at', { withTimezone: true }),
})

export const insertInviteCodeSchema = createInsertSchema(inviteCodes).omit({ createdAt: true })
export type InsertInviteCode = z.infer<typeof insertInviteCodeSchema>
export type InviteCode = typeof inviteCodes.$inferSelect

// ── watchlist ─────────────────────────────────────────────────────────────────

export const watchlist = pgTable('watchlist', {
  userId:  integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ticker:  text('ticker').notNull(),
  tier:    integer('tier').notNull(),
  status:  text('status').notNull(),  // want_to_own | assigned | monitoring | closed
  addedAt: timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  notes:   text('notes'),
}, t => ({
  pk: primaryKey({ columns: [t.userId, t.ticker] }),
}))

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
  userId:       integer('user_id').references(() => users.id, { onDelete: 'set null' }),
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

// ── ticker_fundamentals ───────────────────────────────────────────────────────
// One row per ticker. Written by the FMP refresh job (weekly cadence or on-demand).
// The /stocks/quote handler reads from this table as the primary fundamentals source.
// Yahoo Finance remains the source for price, 52w range, and market data only.

export const tickerFundamentals = pgTable('ticker_fundamentals', {
  ticker:                     text('ticker').primaryKey(),
  fundamentalsLastFetched:    timestamp('fundamentals_last_fetched', { withTimezone: true }),
  // comma-separated list of fields where FMP vs Yahoo diverged >20%
  discrepancyFlags:           text('discrepancy_flags'),
  fmpCoveragePercent:         numeric('fmp_coverage_percent'),

  // Replaces Yahoo financialData + defaultKeyStatistics modules
  peRatio:                    numeric('pe_ratio'),
  pegRatio:                   numeric('peg_ratio'),
  priceToBook:                numeric('price_to_book'),
  priceToSales:               numeric('price_to_sales'),
  // NOTE: raw ratio — no ×100 adjustment (Yahoo was ×100, FMP is not)
  debtToEquity:               numeric('debt_to_equity'),
  totalRevenue:               numeric('total_revenue'),
  revenueGrowthYoY:           numeric('revenue_growth_yoy'),
  netIncome:                  numeric('net_income'),
  ebitda:                     numeric('ebitda'),
  earningsPerShare:           numeric('earnings_per_share'),
  epsGrowth:                  numeric('eps_growth'),
  freeCashFlow:               numeric('free_cash_flow'),
  dividendYield:              numeric('dividend_yield'),
  returnOnEquity:             numeric('return_on_equity'),
  returnOnAssets:             numeric('return_on_assets'),
  currentRatio:               numeric('current_ratio'),
  grossMargin:                numeric('gross_margin'),
  operatingMargin:            numeric('operating_margin'),
  netMargin:                  numeric('net_margin'),
  beta:                       numeric('beta'),
  analystTargetPrice:         numeric('analyst_target_price'),

  // Phase 3 Safety/Quality scorer inputs
  wacc:                       numeric('wacc'),
  roic:                       numeric('roic'),
  // always stored positive (Math.abs applied at fetch time)
  interestExpense:            numeric('interest_expense'),
  totalDebt:                  numeric('total_debt'),
  totalStockholdersEquity:    numeric('total_stockholders_equity'),
  ebit:                       numeric('ebit'),
  effectiveTaxRate:           numeric('effective_tax_rate'),
  cashAndEquivalents:         numeric('cash_and_equivalents'),
  // most-recent quarterly OCF (negative = cash burn, positive = cash-generative)
  quarterlyOperatingCashFlow: numeric('quarterly_operating_cash_flow'),
  sharesOutstanding:          numeric('shares_outstanding'),
  sharesOutstandingPrior:     numeric('shares_outstanding_prior'),

  // Phase 1A additions — data source tracking
  lastSource:         text('last_source').default('fmp'),
  dataQualityScore:   numeric('data_quality_score'), // 0-1, percentage of non-null fields
})

export const insertTickerFundamentalsSchema = createInsertSchema(tickerFundamentals)
export type InsertTickerFundamentals = z.infer<typeof insertTickerFundamentalsSchema>
export type TickerFundamentalsRow = typeof tickerFundamentals.$inferSelect

// ── fmp_api_usage ─────────────────────────────────────────────────────────────
// Single-row table (id always = 1) tracking daily FMP API call consumption.
// Prevents exhausting the ~250-call/day quota during development.
// Reset when resetDate differs from today's date.

export const fmpApiUsage = pgTable('fmp_api_usage', {
  id:         integer('id').primaryKey(),    // always 1
  callsToday: integer('calls_today').notNull().default(0),
  resetDate:  text('reset_date').notNull(), // YYYY-MM-DD
})
export type FmpApiUsageRow = typeof fmpApiUsage.$inferSelect

// ── ticker_technicals ─────────────────────────────────────────────────────────
// One row per ticker. Written by the daily technicals refresh job.
// The /technicals/all endpoint returns all rows for the V2 technical scorer.
// Computation source: pricesHistorical OHLCV (no Yahoo calls at query time).
// Options fields: computed during refresh from Yahoo options chain.

export const tickerTechnicals = pgTable('ticker_technicals', {
  ticker:                   text('ticker').primaryKey(),
  technicalsLastFetched:    timestamp('technicals_last_fetched', { withTimezone: true }),
  technicalsCoverage:       numeric('technicals_coverage'),      // 0-1

  // ── Momentum indicators ─────────────────────────────────────────────────────
  rsi14:                    numeric('rsi14'),
  rsi14Pct:                 numeric('rsi14_pct'),                // [0,1] self-relative; 0=most oversold
  mfi14:                    numeric('mfi14'),
  mfi14Pct:                 numeric('mfi14_pct'),
  stoch:                    numeric('stoch'),                    // Stochastic %K
  stochPct:                 numeric('stoch_pct'),
  macdHist:                 numeric('macd_hist'),
  macdDirection:            text('macd_direction'),              // UP|DOWN|FLAT
  atr14:                    numeric('atr14'),
  atr14Pct:                 numeric('atr14_pct'),               // expanding/contracting vs own history
  rsiVelocity:              numeric('rsi_velocity'),             // RSI change over last 3 bars

  // ── Volume ──────────────────────────────────────────────────────────────────
  volumeRatio:              numeric('volume_ratio'),             // today / 20d avg
  volumeRatioPct:           numeric('volume_ratio_pct'),        // self-relative percentile [0,1]

  // ── Volatility ──────────────────────────────────────────────────────────────
  realizedVol20d:           numeric('realized_vol_20d'),         // annualized 20d std of log returns (%)
  bbUpper:                  numeric('bb_upper'),
  bbLower:                  numeric('bb_lower'),
  bbWidth:                  numeric('bb_width'),                 // (upper-lower)/middle
  bbWidthPct:               numeric('bb_width_pct'),            // self-relative percentile [0,1]
  priceZScore:              numeric('price_z_score'),            // (price - 20d mean) / 20d std

  // ── Moving averages ─────────────────────────────────────────────────────────
  ma20:                     numeric('ma20'),
  ma50:                     numeric('ma50'),
  ma200:                    numeric('ma200'),
  ma50Slope10d:             numeric('ma50_slope_10d'),           // (ma50_now - ma50_10d_ago) / ma50_10d_ago
  priceVsMa20Atr:           numeric('price_vs_ma20_atr'),        // (price - MA20) / ATR14
  priceVsMa50Atr:           numeric('price_vs_ma50_atr'),
  priceVsMa200Atr:          numeric('price_vs_ma200_atr'),

  // ── Support / resistance ────────────────────────────────────────────────────
  swingHigh20d:             numeric('swing_high_20d'),
  swingLow20d:              numeric('swing_low_20d'),
  swingHigh50d:             numeric('swing_high_50d'),
  swingLow50d:              numeric('swing_low_50d'),
  vwap20d:                  numeric('vwap_20d'),
  priceVsVwapPct:           numeric('price_vs_vwap_pct'),       // (price-vwap)/vwap as % (e.g. -2.5)
  pivotPoint:               numeric('pivot_point'),
  pivotR1:                  numeric('pivot_r1'),
  pivotS1:                  numeric('pivot_s1'),
  nearestSupportDistPct:    numeric('nearest_support_dist_pct'), // % distance price to nearest support
  nearestResistDistPct:     numeric('nearest_resist_dist_pct'),

  // ── Regime + breakdown ──────────────────────────────────────────────────────
  regime:                   text('regime'),                      // BULLISH|NEUTRAL|BEARISH
  fallingKnife:             integer('falling_knife'),            // 0|1

  // ── Options flow ────────────────────────────────────────────────────────────
  // atmPutIv: true implied vol from ATM put (%). realizedVol20d is OHLCV-derived.
  // NOTE: ivRank/ivPercentile currently use realized vol history (ATM IV history not stored yet).
  atmPutIv:                 numeric('atm_put_iv'),               // ATM put IV % from options chain
  ivRank:                   numeric('iv_rank'),                  // realized vol percentile [0,1]
  ivPercentile:             numeric('iv_percentile'),            // 0-100
  impliedMoveWeekly:        numeric('implied_move_weekly'),      // straddle/spot or atmPutIv/sqrt(52)
  ivVsRealizedVol:          numeric('iv_vs_realized_vol'),       // atmPutIv% / realizedVol20d%
  putCallVolumeRatio:       numeric('put_call_volume_ratio'),    // sum(put vol) / sum(call vol)
  basicSkew:                numeric('basic_skew'),               // (OTM put IV - OTM call IV) * 100
  ivTermStructure:          numeric('iv_term_structure'),        // near/far expiry ATM put IV ratio

  // ── Tier 2 placeholders (always null — requires dealer/flow data) ───────────
  gexNet:                   numeric('gex_net'),
  putWallStrike:            numeric('put_wall_strike'),
  callWallStrike:           numeric('call_wall_strike'),
  maxPainStrike:            numeric('max_pain_strike'),
  deltaSkew25:              numeric('delta_skew_25'),

  // ── Earnings ────────────────────────────────────────────────────────────────
  earningsDaysOut:          integer('earnings_days_out'),        // null if no known date
})

export const insertTickerTechnicalsSchema = createInsertSchema(tickerTechnicals)
export type InsertTickerTechnicals = z.infer<typeof insertTickerTechnicalsSchema>
export type TickerTechnicalsRow = typeof tickerTechnicals.$inferSelect

// ── data_sources ──────────────────────────────────────────────────────────────
// Tracks available data providers, their daily call budgets, and usage.

export const dataSources = pgTable('data_sources', {
  id:            serial('id').primaryKey(),
  name:          text('name').unique().notNull(), // factset | simfin | finnhub | edgar | fmp
  priority:      integer('priority').notNull(),   // lower = higher priority
  dailyLimit:    integer('daily_limit').notNull(),
  callsToday:    integer('calls_today').notNull().default(0),
  lastResetDate: text('last_reset_date').notNull(), // YYYY-MM-DD
  isActive:      boolean('is_active').notNull().default(true),
})

export const insertDataSourceSchema = createInsertSchema(dataSources).omit({ id: true })
export type InsertDataSource = z.infer<typeof insertDataSourceSchema>
export type DataSourceRow = typeof dataSources.$inferSelect

// ── ticker_registry ───────────────────────────────────────────────────────────
// Master list of tracked tickers with metadata, peers, and index memberships.

export const tickerRegistry = pgTable('ticker_registry', {
  ticker:           text('ticker').primaryKey(),
  name:             text('name'),
  sector:           text('sector'),
  industryGroup:    text('industry_group'),
  peerTickers:      text('peer_tickers').array(),           // array of ticker strings
  indexMemberships: text('index_memberships').array(),      // 'SP100' | 'NDX100' | 'DJIA'
  isActive:         boolean('is_active').notNull().default(true),
  addedAt:          timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
})

export const insertTickerRegistrySchema = createInsertSchema(tickerRegistry).omit({ addedAt: true })
export type InsertTickerRegistry = z.infer<typeof insertTickerRegistrySchema>
export type TickerRegistryRow = typeof tickerRegistry.$inferSelect

// ── ticker_fundamentals_history ───────────────────────────────────────────────
// Annual historical fundamental data per ticker. Used by scorer V3 for self-relative scoring.

export const tickerFundamentalsHistory = pgTable('ticker_fundamentals_history', {
  ticker:           text('ticker').notNull(),
  year:             integer('year').notNull(),
  peRatio:          numeric('pe_ratio'),
  priceToBook:      numeric('price_to_book'),
  roic:             numeric('roic'),
  grossMargin:      numeric('gross_margin'),
  operatingMargin:  numeric('operating_margin'),
  netMargin:        numeric('net_margin'),
  revenue:          numeric('revenue'),
  ebitda:           numeric('ebitda'),
  eps:              numeric('eps'),
  source:           text('source').notNull(), // which data source provided this row
  importedAt:       timestamp('imported_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  pk: primaryKey({ columns: [t.ticker, t.year] }),
}))

export const insertTickerFundamentalsHistorySchema = createInsertSchema(tickerFundamentalsHistory).omit({ importedAt: true })
export type InsertTickerFundamentalsHistory = z.infer<typeof insertTickerFundamentalsHistorySchema>
export type TickerFundamentalsHistory = typeof tickerFundamentalsHistory.$inferSelect

// ── earnings_calendar ─────────────────────────────────────────────────────────
// Scheduled and historical earnings events per ticker.

export const earningsCalendar = pgTable('earnings_calendar', {
  ticker:      text('ticker').notNull(),
  reportDate:  date('report_date').notNull(),
  isConfirmed: boolean('is_confirmed').notNull().default(false),
  epsEstimate: numeric('eps_estimate'),
  epsActual:   numeric('eps_actual'),
  surprisePct: numeric('surprise_pct'),
  fetchedAt:   timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  pk: primaryKey({ columns: [t.ticker, t.reportDate] }),
}))

export const insertEarningsCalendarSchema = createInsertSchema(earningsCalendar).omit({ fetchedAt: true })
export type InsertEarningsCalendar = z.infer<typeof insertEarningsCalendarSchema>
export type EarningsCalendarRow = typeof earningsCalendar.$inferSelect
