import { pgTable, text, integer, numeric, bigint, date, timestamp, serial, boolean, primaryKey, index, jsonb, unique } from 'drizzle-orm/pg-core'
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
  lastLoginAt:  timestamp('last_login_at', { withTimezone: true }),
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
  notes:        text('notes'),
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

  // Phase 4 — extended value / acceleration fields
  forwardPe:                  numeric('forward_pe'),
  evEbitda:                   numeric('ev_ebitda'),
  evRevenue:                  numeric('ev_revenue'),
  revenueGrowthYoyPrior:      numeric('revenue_growth_yoy_prior'),

  // Phase 1A additions — data source tracking
  lastSource:         text('last_source').default('fmp'),
  dataQualityScore:   numeric('data_quality_score'), // 0-1, percentage of non-null fields
  // Regime active when this row's scores were last computed — audit trail for regime-driven rank shifts
  regimeAtScore:      text('regime_at_score'),
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

// ── peer_groups ───────────────────────────────────────────────────────────────
// Logical peer groups used for relative fundamental scoring.
// scoring_mode drives which metric weights / exclusions apply.

export const peerGroups = pgTable('peer_groups', {
  id:               text('id').primaryKey(),                   // e.g. 'technology.semiconductors_design'
  name:             text('name').notNull(),
  scoringMode:      text('scoring_mode').notNull(),            // 'standard' | 'financial' | 'reit' | etc.
  metricExclusions: text('metric_exclusions').array(),         // metrics skipped for this group
  benchmarks:       text('benchmarks').array(),                // optional index/ETF benchmarks
  lowConfidence:    boolean('low_confidence').notNull().default(false),
})

export type PeerGroup = typeof peerGroups.$inferSelect
export type InsertPeerGroup = typeof peerGroups.$inferInsert

// ── peer_group_members ────────────────────────────────────────────────────────
// Junction table: which tickers belong to each peer group.
// A ticker may appear in multiple groups; ticker_registry.primary_peer_group_id
// records which group is canonical for scoring.

export const peerGroupMembers = pgTable('peer_group_members', {
  groupId: text('group_id').notNull().references(() => peerGroups.id, { onDelete: 'cascade' }),
  ticker:  text('ticker').notNull(),
}, t => ({
  pk: primaryKey({ columns: [t.groupId, t.ticker] }),
}))

export type PeerGroupMember = typeof peerGroupMembers.$inferSelect
export type InsertPeerGroupMember = typeof peerGroupMembers.$inferInsert

// ── ticker_registry ───────────────────────────────────────────────────────────
// Master list of tracked tickers with metadata, peers, and index memberships.

export const tickerRegistry = pgTable('ticker_registry', {
  ticker:              text('ticker').primaryKey(),
  name:                text('name'),
  sector:              text('sector'),
  industryGroup:       text('industry_group'),
  peerTickers:         text('peer_tickers').array(),            // array of ticker strings
  indexMemberships:    text('index_memberships').array(),       // 'SP100' | 'NDX100' | 'DJIA'
  primaryPeerGroupId:  text('primary_peer_group_id').references(() => peerGroups.id),
  isActive:            boolean('is_active').notNull().default(true),
  addedAt:             timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
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

// ── app_config ────────────────────────────────────────────────────────────────
// Key-value store for app-wide settings (e.g. scoring_weights JSON).

export const appConfig = pgTable('app_config', {
  key:       text('key').primaryKey(),
  value:     jsonb('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export type AppConfigRow = typeof appConfig.$inferSelect
// ── tradePosts ────────────────────────────────────────────────────────────────

export const tradePosts = pgTable('trade_posts', {
  id:                   serial('id').primaryKey(),
  userId:               integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ticker:               text('ticker').notNull(),
  tradeType:            text('trade_type').notNull().default('SELL_PUT'),
  strike:               numeric('strike').notNull(),
  expiry:               date('expiry').notNull(),
  contracts:            integer('contracts').notNull().default(1),
  premiumPerContract:   numeric('premium_per_contract').notNull(),
  confidence:           integer('confidence').notNull(),
  notes:                text('notes'),
  ivRankAtEntry:        numeric('iv_rank_at_entry'),
  techScoreAtEntry:     numeric('tech_score_at_entry'),
  regimeAtEntry:        text('regime_at_entry'),
  vixAtEntry:           numeric('vix_at_entry'),
  signalAtEntry:        text('signal_at_entry'),
  direction:            text('direction'),            // 'long' | 'short' (equity trades)
  entryPrice:           numeric('entry_price'),       // equity entry price
  shares:               integer('shares'),            // equity share count
  stopLoss:             numeric('stop_loss'),
  targetPrice:          numeric('target_price'),
  status:               text('status').notNull().default('OPEN'),
  closePremium:         numeric('close_premium'),
  resolvedAt:           timestamp('resolved_at', { withTimezone: true }),
  resolvedPnl:          numeric('resolved_pnl'),
  createdAt:            timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:            timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const insertTradePostSchema = createInsertSchema(tradePosts).omit({ id: true, createdAt: true, updatedAt: true })
export type InsertTradePost = z.infer<typeof insertTradePostSchema>
export type TradePost = typeof tradePosts.$inferSelect

// ── likes ─────────────────────────────────────────────────────────────────────

export const likes = pgTable('likes', {
  id:        serial('id').primaryKey(),
  postId:    integer('post_id').notNull().references(() => tradePosts.id, { onDelete: 'cascade' }),
  userId:    integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueLike: unique().on(t.postId, t.userId),
}))

export const insertLikeSchema = createInsertSchema(likes).omit({ id: true, createdAt: true })
export type InsertLike = z.infer<typeof insertLikeSchema>
export type Like = typeof likes.$inferSelect

// ── comments ──────────────────────────────────────────────────────────────────

export const comments = pgTable('comments', {
  id:        serial('id').primaryKey(),
  postId:    integer('post_id').notNull().references(() => tradePosts.id, { onDelete: 'cascade' }),
  userId:    integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  body:      text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const insertCommentSchema = createInsertSchema(comments).omit({ id: true, createdAt: true })
export type InsertComment = z.infer<typeof insertCommentSchema>
export type Comment = typeof comments.$inferSelect

// ── stock_buckets ─────────────────────────────────────────────────────────────
// Per-user Bullish / Neutral / Bearish categorization of tickers.
// One user can only have each ticker in one bucket at a time (PK enforces this).

export const stockBuckets = pgTable('stock_buckets', {
  userId:  integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ticker:  text('ticker').notNull(),
  bucket:  text('bucket').notNull(), // 'BULLISH' | 'NEUTRAL' | 'BEARISH'
  addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  pk: primaryKey({ columns: [t.userId, t.ticker] }),
}))

export const insertStockBucketSchema = createInsertSchema(stockBuckets).omit({ addedAt: true })
export type InsertStockBucket = z.infer<typeof insertStockBucketSchema>
export type StockBucket = typeof stockBuckets.$inferSelect

// ── portfolio_snapshots ───────────────────────────────────────────────────────

export const portfolioSnapshots = pgTable('portfolio_snapshots', {
  id:           serial('id').primaryKey(),
  importedAt:   timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
  accountIds:   text('account_ids').array().notNull().default([]),
  totalValue:   numeric('total_value'),
  rawFilename:  text('raw_filename'),
})

export type PortfolioSnapshot = typeof portfolioSnapshots.$inferSelect
export type InsertPortfolioSnapshot = typeof portfolioSnapshots.$inferInsert

// ── portfolio_positions ───────────────────────────────────────────────────────

export const portfolioPositions = pgTable('portfolio_positions', {
  id:               serial('id').primaryKey(),
  snapshotId:       integer('snapshot_id').notNull().references(() => portfolioSnapshots.id, { onDelete: 'cascade' }),
  account:          text('account').notNull(),
  accountNickname:  text('account_nickname'),
  symbol:           text('symbol').notNull(),
  quantity:         numeric('quantity'),
  avgCost:          numeric('avg_cost'),
  lastPrice:        numeric('last_price'),
  marketValue:      numeric('market_value'),
  costBasis:        numeric('cost_basis'),
  unrealizedPnL:    numeric('unrealized_pnl'),
  pnlPct:           numeric('pnl_pct'),
  dayChangePct:     numeric('day_change_pct'),
  bid:              numeric('bid'),
  ask:              numeric('ask'),
}, t => ({
  snapshotIdx: index('portfolio_positions_snapshot_idx').on(t.snapshotId),
}))

export type PortfolioPosition = typeof portfolioPositions.$inferSelect
export type InsertPortfolioPosition = typeof portfolioPositions.$inferInsert

// ── portfolio_options ─────────────────────────────────────────────────────────

export const portfolioOptions = pgTable('portfolio_options', {
  id:             serial('id').primaryKey(),
  snapshotId:     integer('snapshot_id').notNull().references(() => portfolioSnapshots.id, { onDelete: 'cascade' }),
  account:        text('account').notNull(),
  symbol:         text('symbol').notNull(),
  optionType:     text('option_type'),       // 'call' | 'put'
  strike:         numeric('strike'),
  expiration:     date('expiration'),
  direction:      text('direction'),          // 'long' | 'short'
  qty:            numeric('qty'),
  avgPremium:     numeric('avg_premium'),
  totalPremium:   numeric('total_premium'),
  markPrice:      numeric('mark_price'),
  unrealizedPnL:  numeric('unrealized_pnl'),
  pnlPct:         numeric('pnl_pct'),
  iv:             numeric('iv'),
  delta:          numeric('delta'),
  gamma:          numeric('gamma'),
  theta:          numeric('theta'),
  vega:           numeric('vega'),
}, t => ({
  snapshotIdx: index('portfolio_options_snapshot_idx').on(t.snapshotId),
}))

export type PortfolioOption = typeof portfolioOptions.$inferSelect
export type InsertPortfolioOption = typeof portfolioOptions.$inferInsert

// ── portfolio_orders ──────────────────────────────────────────────────────────

export const portfolioOrders = pgTable('portfolio_orders', {
  id:               serial('id').primaryKey(),
  snapshotId:       integer('snapshot_id').notNull().references(() => portfolioSnapshots.id, { onDelete: 'cascade' }),
  account:          text('account').notNull(),
  symbol:           text('symbol').notNull(),
  side:             text('side'),             // 'buy' | 'sell'
  orderType:        text('order_type'),       // 'market' | 'limit' | 'stop' etc.
  state:            text('state'),            // 'filled' | 'cancelled' | 'pending' etc.
  quantity:         numeric('quantity'),
  avgFillPrice:     numeric('avg_fill_price'),
  createdAt:        timestamp('created_at', { withTimezone: true }),
  isOption:         boolean('is_option').notNull().default(false),
  optionStrike:     numeric('option_strike'),
  optionExpiration: date('option_expiration'),
  optionSide:       text('option_side'),      // 'call' | 'put'
}, t => ({
  snapshotIdx: index('portfolio_orders_snapshot_idx').on(t.snapshotId),
}))

export type PortfolioOrder = typeof portfolioOrders.$inferSelect
export type InsertPortfolioOrder = typeof portfolioOrders.$inferInsert

// ── market_regime ─────────────────────────────────────────────────────────────
// Classifier output: one row per run. Keep latest 90 rows; prune manually via
//   DELETE FROM market_regime WHERE id NOT IN (SELECT id FROM market_regime ORDER BY computed_at DESC LIMIT 90)

export const marketRegime = pgTable('market_regime', {
  id:                 serial('id').primaryKey(),
  regime:             text('regime').notNull(),            // 'expansion' | 'late_cycle' | 'contraction' | 'recession' | 'recovery' | 'stagflation'
  confidence:         integer('confidence').notNull(),      // 0–100
  signalScores:       jsonb('signal_scores').notNull(),     // { expansion: 14, late_cycle: 9, ... }
  confirmingSignals:  text('confirming_signals').array().notNull(),  // top 3 driving indicators
  conflictingSignals: text('conflicting_signals').array().notNull(), // contradicting indicators
  indicatorSnapshot:  jsonb('indicator_snapshot').notNull(),         // full input values at classification time
  computedAt:         timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  computedBy:         text('computed_by').notNull().default('system'), // 'system' | userId
}, t => ({
  computedAtIdx: index('idx_market_regime_computed_at').on(t.computedAt),
}))

export const insertMarketRegimeSchema = createInsertSchema(marketRegime).omit({ id: true, computedAt: true })
export type InsertMarketRegime = z.infer<typeof insertMarketRegimeSchema>
export type MarketRegime = typeof marketRegime.$inferSelect

// ── unmapped_tickers ──────────────────────────────────────────────────────────
// Tickers that classifyTicker could not map to any peer group. Reviewed manually.

export const unmappedTickers = pgTable('unmapped_tickers', {
  ticker: text('ticker').primaryKey(),
  seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
})

export type UnmappedTicker = typeof unmappedTickers.$inferSelect

// ── source_ticker_map ─────────────────────────────────────────────────────────
// Maps internal ticker symbols to the symbol each data source expects.
// Needed because FMP, Yahoo, and Polygon sometimes use different symbols
// (e.g. BRK.B vs BRK-B) and FMP free tier may not cover small-caps at all.

export const sourceTickerMap = pgTable('source_ticker_map', {
  ticker:       text('ticker').notNull(),
  source:       text('source').notNull(),      // 'yahoo' | 'fmp' | 'polygon' | 'alpha_vantage'
  sourceTicker: text('source_ticker').notNull(),
  active:       boolean('active').notNull().default(true),
  notes:        text('notes'),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.ticker, t.source] })])

export type SourceTickerMap = typeof sourceTickerMap.$inferSelect
export type InsertSourceTickerMap = typeof sourceTickerMap.$inferInsert

// ── yahoo_fundamentals ────────────────────────────────────────────────────────
// Raw Yahoo Finance data per ticker. One row per ticker, keyed by ticker.
// Field names mirror Yahoo's own API field names (yahoo_ prefix) so the source
// is always unambiguous. Never read by the scorer — ticker_fundamentals is the
// scorer's source. This is a raw staging/audit table only.
// Written by: yahoo-client.ts → backfill-yahoo.ts
// Read by: validate-yahoo-fields.ts (comparison against FMP values)

export const yahooFundamentals = pgTable('yahoo_fundamentals', {
  ticker:     text('ticker').primaryKey(),
  fetchedAt:  timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),

  // financialData module (TTM) — margins/ratios as decimals, large numbers as raw dollars
  yahooGrossMargins:       numeric('yahoo_gross_margins'),
  yahooOperatingMargins:   numeric('yahoo_operating_margins'),
  yahooProfitMargins:      numeric('yahoo_profit_margins'),
  yahooReturnOnEquity:     numeric('yahoo_return_on_equity'),
  yahooReturnOnAssets:     numeric('yahoo_return_on_assets'),
  yahooRevenueGrowth:      numeric('yahoo_revenue_growth'),
  yahooDebtToEquity:       numeric('yahoo_debt_to_equity'),  // normalized to raw ratio (not ×100)
  yahooCurrentRatio:       numeric('yahoo_current_ratio'),
  yahooTotalRevenue:       numeric('yahoo_total_revenue'),
  yahooTotalDebt:          numeric('yahoo_total_debt'),
  yahooTotalCash:          numeric('yahoo_total_cash'),
  yahooFreeCashflow:       numeric('yahoo_free_cashflow'),
  yahooOperatingCashflow:  numeric('yahoo_operating_cashflow'),
  yahooEbitda:             numeric('yahoo_ebitda'),
  yahooTargetMeanPrice:    numeric('yahoo_target_mean_price'),

  // defaultKeyStatistics module
  yahooForwardPe:              numeric('yahoo_forward_pe'),
  yahooPegRatio:               numeric('yahoo_peg_ratio'),
  yahooPriceToBook:            numeric('yahoo_price_to_book'),
  yahooEnterpriseToEbitda:     numeric('yahoo_enterprise_to_ebitda'),
  yahooEnterpriseToRevenue:    numeric('yahoo_enterprise_to_revenue'),
  yahooTrailingEps:            numeric('yahoo_trailing_eps'),
  yahooForwardEps:             numeric('yahoo_forward_eps'),
  yahooBeta:                   numeric('yahoo_beta'),
  yahooSharesOutstanding:      numeric('yahoo_shares_outstanding'),
  yahooFloatShares:            numeric('yahoo_float_shares'),
  yahooHeldPercentInsiders:    numeric('yahoo_held_percent_insiders'),
  yahooShortRatio:             numeric('yahoo_short_ratio'),

  // incomeStatementHistory module (most recent annual 10-K)
  yahooAnnualTotalRevenue:  numeric('yahoo_annual_total_revenue'),
  yahooAnnualGrossProfit:   numeric('yahoo_annual_gross_profit'),
  yahooAnnualEbit:          numeric('yahoo_annual_ebit'),
  yahooAnnualNetIncome:     numeric('yahoo_annual_net_income'),
  yahooAnnualRevenueYoy:    numeric('yahoo_annual_revenue_yoy'),  // computed: (yr0-yr1)/|yr1|

  // balanceSheetHistory module (most recent annual 10-K)
  yahooAnnualCash:          numeric('yahoo_annual_cash'),
  yahooAnnualTotalDebt:     numeric('yahoo_annual_total_debt'),   // longTermDebt + shortLongTermDebt
  yahooAnnualTotalEquity:   numeric('yahoo_annual_total_equity'),

  // cashflowStatementHistory module (most recent annual 10-K)
  yahooAnnualOperatingCashFlow:  numeric('yahoo_annual_operating_cash_flow'),
  yahooAnnualCapex:              numeric('yahoo_annual_capex'),           // stored positive
  yahooAnnualFreeCashFlow:       numeric('yahoo_annual_free_cash_flow'),  // computed: opCF + capex
})

export const insertYahooFundamentalsSchema = createInsertSchema(yahooFundamentals).omit({ fetchedAt: true })
export type InsertYahooFundamentals = z.infer<typeof insertYahooFundamentalsSchema>
export type YahooFundamentalsRow = typeof yahooFundamentals.$inferSelect

// ── ticker_cik ────────────────────────────────────────────────────────────────
// CIK lookup cache so EDGAR search is hit only once per ticker.
// Written by: edgar-client.ts (on first fetch); never expires automatically.

export const tickerCik = pgTable('ticker_cik', {
  ticker:    text('ticker').primaryKey(),
  cik:       text('cik').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
})

export type TickerCikRow = typeof tickerCik.$inferSelect

// ── edgar_fundamentals ────────────────────────────────────────────────────────
// Raw SEC EDGAR XBRL data per ticker. One row per ticker, most recent 10-K.
// Staging/audit table only — ticker_fundamentals is the scorer's source.
// Written by: edgar-client.ts → backfill-edgar.ts

export const edgarFundamentals = pgTable('edgar_fundamentals', {
  ticker:    text('ticker').primaryKey(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),

  edgarTotalRevenue:       numeric('edgar_total_revenue'),
  edgarGrossProfit:        numeric('edgar_gross_profit'),
  edgarNetIncome:          numeric('edgar_net_income'),
  edgarEbit:               numeric('edgar_ebit'),
  edgarEbitda:             numeric('edgar_ebitda'),           // always null (not in XBRL)
  edgarFreeCashFlow:       numeric('edgar_free_cash_flow'),   // operatingCF - capex
  edgarOperatingCashFlow:  numeric('edgar_operating_cash_flow'),
  edgarCapitalExpenditure: numeric('edgar_capital_expenditure'), // stored positive
  edgarCashAndEquivalents: numeric('edgar_cash_and_equivalents'),
  edgarTotalDebt:          numeric('edgar_total_debt'),
  edgarTotalEquity:        numeric('edgar_total_equity'),
  edgarInterestExpense:    numeric('edgar_interest_expense'),  // stored positive
  edgarSharesOutstanding:  numeric('edgar_shares_outstanding'),
  edgarGrossMargin:        numeric('edgar_gross_margin'),      // computed: grossProfit / totalRevenue
  edgarNetMargin:          numeric('edgar_net_margin'),        // computed: netIncome / totalRevenue
})

export const insertEdgarFundamentalsSchema = createInsertSchema(edgarFundamentals).omit({ fetchedAt: true })
export type InsertEdgarFundamentals = z.infer<typeof insertEdgarFundamentalsSchema>
export type EdgarFundamentalsRow = typeof edgarFundamentals.$inferSelect
