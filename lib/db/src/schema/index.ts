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
  cashBalance:  numeric('cash_balance').notNull().default('100000'), // paper-trading account cash
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
  userId:   integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ticker:   text('ticker').notNull(),
  tier:     integer('tier').notNull(),
  status:   text('status').notNull(),  // want_to_own | assigned | monitoring | closed
  addedAt:  timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
  notes:    text('notes'),
  colorTag: text('color_tag').notNull().default(''),  // hex color from PRESET_COLORS, '' = untagged
}, t => ({
  pk:        primaryKey({ columns: [t.userId, t.ticker] }),
  userIdx:   index('idx_watchlist_user_id').on(t.userId),
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
  userIdx:   index('idx_positions_user_id').on(t.userId),
}))

export const insertPositionSchema = createInsertSchema(positions).omit({ id: true, openedAt: true })
export type InsertPosition = z.infer<typeof insertPositionSchema>
export type Position = typeof positions.$inferSelect

// ── user_portfolio_names ────────────────────────────────────────────────────────
// bug/14 P0 (2026-07-11): table was referenced via raw SQL in routes/positions.ts
// with no Drizzle schema/migration, so it never existed on a fresh DB (500 on
// GET/POST /api/portfolio-names). Unique (userId, name) backs the route's
// `ON CONFLICT DO NOTHING` on insert.

export const userPortfolioNames = pgTable('user_portfolio_names', {
  id:        serial('id').primaryKey(),
  userId:    integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name:      text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
}, t => ({
  userNameUnique: unique('idx_user_portfolio_names_user_name').on(t.userId, t.name),
}))

export type UserPortfolioName = typeof userPortfolioNames.$inferSelect
export type InsertUserPortfolioName = typeof userPortfolioNames.$inferInsert

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
  /** Provenance: yahoo | lseg (ranked fallback — never silently overwrite without source). */
  source: text('source'),
}, t => ({
  pk:        primaryKey({ columns: [t.ticker, t.date] }),
  lookupIdx: index('idx_prices_lookup').on(t.ticker, t.date),
}))

export const insertPriceSchema = createInsertSchema(pricesHistorical)
export type InsertPrice = z.infer<typeof insertPriceSchema>
export type PriceRow = typeof pricesHistorical.$inferSelect

// ── yahoo_analyst_actions (bronze) ────────────────────────────────────────────
// Raw Yahoo upgradeDowngradeHistory events, one row per distinct event.
// sourceEventId is a stable hash of (ticker, firm, epochGradeDate, fromGrade,
// toGrade) so repeated backfills upsert instead of duplicating rows.

export const yahooAnalystActions = pgTable('yahoo_analyst_actions', {
  ticker:        text('ticker').notNull(),
  firm:          text('firm').notNull(),
  action:        text('action').notNull(),        // raw Yahoo action: up | down | main | init | reit
  fromGrade:     text('from_grade'),
  toGrade:       text('to_grade'),
  eventDate:     date('event_date').notNull(),
  sourceEventId: text('source_event_id').notNull(),
  raw:           jsonb('raw'),
  fetchedAt:     timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  pk:         primaryKey({ columns: [t.ticker, t.sourceEventId] }),
  fetchedIdx: index('idx_yahoo_analyst_actions_ticker_fetched').on(t.ticker, t.fetchedAt),
}))

export const insertYahooAnalystActionSchema = createInsertSchema(yahooAnalystActions)
export type InsertYahooAnalystAction = z.infer<typeof insertYahooAnalystActionSchema>
export type YahooAnalystAction = typeof yahooAnalystActions.$inferSelect

// ── analyst_events (gold) ─────────────────────────────────────────────────────
// Normalized, route-facing analyst rating-change events. Single-source
// (Yahoo) today — written in the same transaction as the bronze row, no
// FIELD_DEFS merge needed.

export const analystEvents = pgTable('analyst_events', {
  ticker:      text('ticker').notNull(),
  firm:        text('firm').notNull(),
  source:      text('source').notNull().default('yahoo'), // yahoo | fmp-grade | fmp-target
  action:      text('action').notNull(),           // upgrade | downgrade | initiate | maintain | reiterate | price-target
  fromGrade:   text('from_grade'),
  toGrade:     text('to_grade'),
  eventDate:   date('event_date').notNull(),
  // Per-firm price target — only populated for fmp-target rows (FMP's grades feed and
  // price-target feed are separate un-mergeable streams; see analyst-price-target skill note).
  priceTarget: numeric('price_target'),
  newsTitle:   text('news_title'),
  fetchedAt:   timestamp('fetched_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  pk:         primaryKey({ columns: [t.ticker, t.firm, t.eventDate, t.source] }),
  fetchedIdx: index('idx_analyst_events_ticker_fetched').on(t.ticker, t.fetchedAt),
}))

export const insertAnalystEventSchema = createInsertSchema(analystEvents)
export type InsertAnalystEvent = z.infer<typeof insertAnalystEventSchema>
export type AnalystEvent = typeof analystEvents.$inferSelect

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
// One row per ticker. Written by merge-trusted.ts (per-field source priority merge).
// The /stocks/quote handler reads from this table as the primary fundamentals source.
// Yahoo Finance remains the source for price, 52w range, and market data only.

export const tickerFundamentals = pgTable('ticker_fundamentals', {
  ticker:                     text('ticker').primaryKey(),
  fundamentalsLastFetched:    timestamp('fundamentals_last_fetched', { withTimezone: true }),
  // comma-separated list of fields where FMP vs Yahoo diverged >20%
  discrepancyFlags:           text('discrepancy_flags'),
  // comma-separated list of fields currently resolved via manual_overrides (admin picked a
  // non-default source after analysis) — lets the grid outline those cells without a
  // per-cell provenance fetch, same pattern as discrepancyFlags.
  overrideFlags:              text('override_flags'),
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
  /** Derived: forwardPe / (epsGrowth×100) — same growth basis as pegRatio */
  forwardPeg:                 numeric('forward_peg'),
  evEbitda:                   numeric('ev_ebitda'),
  evRevenue:                  numeric('ev_revenue'),
  revenueGrowthYoyPrior:      numeric('revenue_growth_yoy_prior'),

  // Phase fund-score-v2 — GPA / accruals inputs
  grossProfit:                numeric('gross_profit'),
  totalAssets:                numeric('total_assets'),
  annualOperatingCashFlow:    numeric('annual_operating_cash_flow'),
  // Specialty free proxies (banks P/TBV; REIT FFO≈NI+D&A)
  tangibleBookValuePerShare:  numeric('tangible_book_value_per_share'),
  depreciationAmortization:   numeric('depreciation_amortization'),
  ffoProxy:                   numeric('ffo_proxy'),

  // Phase 1A additions — data source tracking
  lastSource:         text('last_source').default('fmp'),
  dataQualityScore:   numeric('data_quality_score'), // 0-1, percentage of non-null fields
  // Regime active when this row's scores were last computed — audit trail for regime-driven rank shifts
  regimeAtScore:      text('regime_at_score'),

  // Persisted fundamental scores — recomputed after every refresh or override
  fundTotalScore:        numeric('fund_total_score'),
  fundCompanyScore:      numeric('fund_company_score'), // pre sector-layer blend
  fundSectorScore:       numeric('fund_sector_score'),  // peer-group opportunity
  fundValueScore:        numeric('fund_value_score'),
  fundQualityScore:      numeric('fund_quality_score'),
  fundGrowthScore:       numeric('fund_growth_score'),
  fundSafetyScore:       numeric('fund_safety_score'),
  fundRank:              integer('fund_rank'),
  fundScoreComputedAt:   timestamp('fund_score_computed_at', { withTimezone: true }),
  styleBucket:           text('style_bucket'),
  fundScoreConfidence:   text('fund_score_confidence'),
}, t => ({
  lastFetchedIdx: index('idx_ticker_fundamentals_last_fetched').on(t.fundamentalsLastFetched),
}))

export const insertTickerFundamentalsSchema = createInsertSchema(tickerFundamentals)
export type InsertTickerFundamentals = z.infer<typeof insertTickerFundamentalsSchema>
export type TickerFundamentalsRow = typeof tickerFundamentals.$inferSelect

// ── fmp_api_usage ─────────────────────────────────────────────────────────────
// Legacy single-row FMP tracker. Kept for backward compat; new code uses api_usage.
export const fmpApiUsage = pgTable('fmp_api_usage', {
  id:         integer('id').primaryKey(),
  callsToday: integer('calls_today').notNull().default(0),
  resetDate:  text('reset_date').notNull(),
})
export type FmpApiUsageRow = typeof fmpApiUsage.$inferSelect

// ── api_usage ─────────────────────────────────────────────────────────────────
// Unified per-source per-day API call counter. Replaces fmp_api_usage and the
// AV flat-file cursor. Sources: fmp, av, polygon, finnhub, yahoo, edgar, fred, cnn.
export const apiUsage = pgTable('api_usage', {
  source:    text('source').notNull(),
  date:      date('date').notNull(),
  callsMade: integer('calls_made').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ pk: primaryKey({ columns: [t.source, t.date] }) }))
export type ApiUsageRow = typeof apiUsage.$inferSelect

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
  // iv_rank provenance: rv_proxy (legacy) | hist_atm | cross_atm
  ivRankSource:             text('iv_rank_source'),
})

export const insertTickerTechnicalsSchema = createInsertSchema(tickerTechnicals)
export type InsertTickerTechnicals = z.infer<typeof insertTickerTechnicalsSchema>
export type TickerTechnicalsRow = typeof tickerTechnicals.$inferSelect

// Daily ATM put IV snapshots — builds true IV-rank history over time.
export const tickerAtmIvSnapshots = pgTable('ticker_atm_iv_snapshots', {
  ticker:       text('ticker').notNull(),
  asOf:         date('as_of').notNull(),
  atmPutIv:     numeric('atm_put_iv').notNull(),
  ivVsRealized: numeric('iv_vs_realized'),
}, (t) => ({
  pk: primaryKey({ columns: [t.ticker, t.asOf] }),
  tickerIdx: index('idx_atm_iv_snapshots_ticker').on(t.ticker),
}))
export type TickerAtmIvSnapshot = typeof tickerAtmIvSnapshots.$inferSelect

// Nightly best-strike option scores for Overall rankings (premium-rich candidates).
export const optionScoreSnapshots = pgTable('option_score_snapshots', {
  ticker:           text('ticker').notNull(),
  side:             text('side').notNull(), // put | call
  asOf:             date('as_of').notNull(),
  strike:           numeric('strike').notNull(),
  expiry:           date('expiry').notNull(),
  spot:             numeric('spot').notNull(),
  premium:          numeric('premium').notNull(),
  weeklyIncomePct:  numeric('weekly_income_pct'),
  otmPct:           numeric('otm_pct'),
  delta:            numeric('delta'),
  strikeIv:         numeric('strike_iv'),
  dte:              numeric('dte'),
  optionScore:      numeric('option_score').notNull(),
  componentScores:  jsonb('component_scores').notNull().default({}),
  earningsDaysOut:  integer('earnings_days_out'),
  earningsRisk:     boolean('earnings_risk').notNull().default(false),
  bidIsLive:        boolean('bid_is_live').notNull().default(true),
  quoteStale:       boolean('quote_stale').notNull().default(false),
  dataQuality:      numeric('data_quality'),
  atmPutIv:         numeric('atm_put_iv'),
  ivVsRealized:     numeric('iv_vs_realized'),
  /** A14 accountability */
  coverage:         numeric('coverage'),
  confidence:       text('confidence'),
  modelVersion:     text('model_version'),
  inputsDigest:     text('inputs_digest'),
  computedAt:       timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ticker, t.side, t.asOf] }),
  asOfIdx: index('idx_option_score_snapshots_as_of').on(t.asOf),
  sideScoreIdx: index('idx_option_score_snapshots_side_score').on(t.side, t.asOf, t.optionScore),
}))
export type OptionScoreSnapshot = typeof optionScoreSnapshots.$inferSelect
export type InsertOptionScoreSnapshot = typeof optionScoreSnapshots.$inferInsert

// ── fund_score_snapshots ──────────────────────────────────────────────────────
// Daily (or intraday override) point-in-time fund scores for history charts +
// auto-attribution. Model-only — never overwritten by desk adj notes.
export const fundScoreSnapshots = pgTable('fund_score_snapshots', {
  ticker:       text('ticker').notNull(),
  asOf:         date('as_of').notNull(),
  fundTotal:    numeric('fund_total'),
  fundValue:    numeric('fund_value'),
  fundGrowth:   numeric('fund_growth'),
  fundQuality:  numeric('fund_quality'),
  fundSafety:   numeric('fund_safety'),
  styleBucket:  text('style_bucket'),
  coverage:     numeric('coverage'),
  confidence:   text('confidence'),
  peerGroupId:  text('peer_group_id'),
  trigger:      text('trigger').notNull().default('nightly'), // nightly | admin_recompute | peer_override | manual_refresh
  topMetrics:   jsonb('top_metrics').notNull().default([]),
  modelVersion: text('model_version'),
  inputsDigest: text('inputs_digest'),
  computedAt:   timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ticker, t.asOf] }),
  tickerAsOfIdx: index('idx_fund_score_snapshots_ticker_as_of').on(t.ticker, t.asOf),
}))
export type FundScoreSnapshot = typeof fundScoreSnapshots.$inferSelect
export type InsertFundScoreSnapshot = typeof fundScoreSnapshots.$inferInsert

// ── tech_score_snapshots (A14) ────────────────────────────────────────────────
export const techScoreSnapshots = pgTable('tech_score_snapshots', {
  ticker:        text('ticker').notNull(),
  asOf:          date('as_of').notNull(),
  techTotal:     numeric('tech_total'),
  components:    jsonb('components').notNull().default({}),
  coverage:      numeric('coverage'),
  confidence:    text('confidence'),
  fallingKnife:  integer('falling_knife'), // 0|1 — real Fildi flag
  peerGroupId:   text('peer_group_id'),
  modelVersion:  text('model_version'),
  inputsDigest:  text('inputs_digest'),
  trigger:       text('trigger').notNull().default('daily'),
  computedAt:    timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ticker, t.asOf] }),
  asOfIdx: index('idx_tech_score_snapshots_as_of').on(t.asOf),
}))
export type TechScoreSnapshot = typeof techScoreSnapshots.$inferSelect
export type InsertTechScoreSnapshot = typeof techScoreSnapshots.$inferInsert

// ── scorecard_params — Cursor-owned versioned weights (A17/A18) ───────────────
// Same shape as watchlist_sync.model_params, but one champion per lane.
export const scorecardParams = pgTable('scorecard_params', {
  version:     text('version').primaryKey(),
  lane:        text('lane').notNull(), // fund | tech | options
  status:      text('status').notNull(), // champion | challenger | retired
  parent:      text('parent'),
  params:      jsonb('params').notNull(),
  rationale:   jsonb('rationale'),
  evidence:    jsonb('evidence'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  promotedAt:  timestamp('promoted_at', { withTimezone: true }),
  approvedBy:  text('approved_by'),
}, (t) => ({
  laneStatusIdx: index('idx_scorecard_params_lane_status').on(t.lane, t.status),
}))
export type ScorecardParam = typeof scorecardParams.$inferSelect
export type InsertScorecardParam = typeof scorecardParams.$inferInsert

// ── fund_score_notes ──────────────────────────────────────────────────────────
// Human accountability layer. Never mutates ticker_fundamentals fund_* columns.
// Optional adj_points → deskScore = model + sum(active adj) for display only.
export const fundScoreNotes = pgTable('fund_score_notes', {
  id:                 serial('id').primaryKey(),
  ticker:             text('ticker').notNull(),
  asOf:               date('as_of').notNull(),
  body:               text('body').notNull(),
  author:             text('author'),
  tags:               jsonb('tags').notNull().default([]),
  adjPoints:          numeric('adj_points'),
  expiresAt:          timestamp('expires_at', { withTimezone: true }),
  linkedSnapshotAsOf: date('linked_snapshot_as_of'),
  createdAt:          timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tickerAsOfIdx: index('idx_fund_score_notes_ticker_as_of').on(t.ticker, t.asOf),
  tickerCreatedIdx: index('idx_fund_score_notes_ticker_created').on(t.ticker, t.createdAt),
}))
export type FundScoreNote = typeof fundScoreNotes.$inferSelect
export type InsertFundScoreNote = typeof fundScoreNotes.$inferInsert

// ── desk_commentaries ─────────────────────────────────────────────────────────
// FactSet StreetAccount (and later SA / other) desk emails → structured rows.
// Drive .eml/.json is the archive; this table is the app-facing index for briefs,
// soft regime context, and scorecard narrative — never a fund-score hard input.

export const deskCommentaries = pgTable('desk_commentaries', {
  id:               serial('id').primaryKey(),
  source:           text('source').notNull().default('factset_streetaccount'),
  kind:             text('kind').notNull(), // us_overnight | us_market_recap | politics | sector_* | macro_oil | other | newsletter slug
  gmailMessageId:   text('gmail_message_id').unique(),
  subject:          text('subject').notNull(),
  receivedAt:       timestamp('received_at', { withTimezone: true }).notNull(),
  ingestedAt:       timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  tickersMentioned: jsonb('tickers_mentioned').notNull().default([]),
  synopsis:         text('synopsis'),
  bodyPlain:        text('body_plain'),
  driveFileName:    text('drive_file_name'),
  meta:             jsonb('meta').notNull().default({}),
  fromAddress:      text('from_address'),
  fromDomain:       text('from_domain'),
  category:         text('category'), // overnight | macro | promo | …
  articlePublishedAt: timestamp('article_published_at', { withTimezone: true }),
  noiseScore:       integer('noise_score'),
  parserVersion:    integer('parser_version'),
}, (t) => ({
  receivedIdx: index('desk_commentaries_received_idx').on(t.receivedAt),
  kindDayIdx:  index('desk_commentaries_kind_day_idx').on(t.kind, t.receivedAt),
  categoryIdx: index('desk_commentaries_category_idx').on(t.category, t.receivedAt),
  noiseIdx:    index('desk_commentaries_noise_idx').on(t.noiseScore),
}))

export type DeskCommentary = typeof deskCommentaries.$inferSelect
export type InsertDeskCommentary = typeof deskCommentaries.$inferInsert

/** User feedback on Daily News Haiku (relevance / ask-why) — soft prefs for next generate. */
export const deskNewsFeedback = pgTable('desk_news_feedback', {
  id:          serial('id').primaryKey(),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  sessionDate: text('session_date').notNull(), // PT dateKey of the brief
  feedbackType: text('feedback_type').notNull(), // not_relevant | ask_why | want_more
  bulletText:  text('bullet_text'),
  reason:      text('reason'),
  question:    text('question'),
  meta:        jsonb('meta').notNull().default({}),
}, (t) => ({
  sessionIdx: index('desk_news_feedback_session_idx').on(t.sessionDate, t.createdAt),
}))

export type DeskNewsFeedback = typeof deskNewsFeedback.$inferSelect

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
  groupId:   text('group_id').notNull().references(() => peerGroups.id, { onDelete: 'cascade' }),
  ticker:    text('ticker').notNull(),
  source:    text('source').notNull().default('taxonomy'),      // 'taxonomy' | 'manual'
  removedAt: timestamp('removed_at', { withTimezone: true }),   // soft-delete: non-null = not an active peer
}, t => ({
  pk: primaryKey({ columns: [t.groupId, t.ticker] }),
}))

export type PeerGroupMember = typeof peerGroupMembers.$inferSelect
export type InsertPeerGroupMember = typeof peerGroupMembers.$inferInsert

// ── peer_group_overrides ────────────────────────────────────────────────────────
// Manual reassignment of a ticker to a different peer group than the auto-classifier
// (peer-classifier.ts) would pick. Presence of a row here is what distinguishes a
// user override from an auto/keyword-matched assignment; deleting the row reverts
// the ticker to auto-classification.

export const peerGroupOverrides = pgTable('peer_group_overrides', {
  ticker:          text('ticker').primaryKey(),
  groupId:         text('group_id').notNull().references(() => peerGroups.id),
  // The ticker's primary_peer_group_id at the moment the override was first
  // created (null if it was unmapped) — lets a revert restore the exact prior
  // value instead of re-running peer-overlap/keyword classification, which can
  // land on a different group than the ticker was originally mapped to.
  previousGroupId: text('previous_group_id'),
  note:            text('note'),
  createdAt:       timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export type PeerGroupOverride = typeof peerGroupOverrides.$inferSelect
export type InsertPeerGroupOverride = typeof peerGroupOverrides.$inferInsert

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
  fetchFundamentals:   boolean('fetch_fundamentals').notNull().default(false),
  addedAt:             timestamp('added_at', { withTimezone: true }).defaultNow().notNull(),
}, t => ({
  sectorIdx:   index('idx_ticker_registry_sector').on(t.sector),
  industryIdx: index('idx_ticker_registry_industry').on(t.industryGroup),
}))

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
  fcf:              numeric('fcf'),
  roe:              numeric('roe'),
  debtToEquity:     numeric('debt_to_equity'),
  currentRatio:     numeric('current_ratio'),
  totalAssets:      numeric('total_assets'),
  grossProfit:      numeric('gross_profit'),
  annualOcf:        numeric('annual_ocf'),
  epsGrowth:        numeric('eps_growth'),
  revenueGrowth:    numeric('revenue_growth'),
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

// ── ticker_event_bullets ─────────────────────────────────────────────────────
// Template-generated bull/bear bullets from the daily event-trigger check
// (earnings beat/miss, analyst upgrade/downgrade, large price move ex-macro).
// Keyed by ticker, not user — cost/storage doesn't scale with watcher count.

export const tickerEventBullets = pgTable('ticker_event_bullets', {
  ticker:      text('ticker').primaryKey(),
  bullBullets: jsonb('bull_bullets').notNull().default([]),
  bearBullets: jsonb('bear_bullets').notNull().default([]),
  triggers:    jsonb('triggers').notNull().default([]),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type TickerEventBulletsRow = typeof tickerEventBullets.$inferSelect

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
}, t => ({
  userIdx:   index('idx_trade_posts_user_id').on(t.userId),
  tickerIdx: index('idx_trade_posts_ticker').on(t.ticker),
}))

export const insertTradePostSchema = createInsertSchema(tradePosts).omit({ id: true, createdAt: true, updatedAt: true })
export type InsertTradePost = z.infer<typeof insertTradePostSchema>
export type TradePost = typeof tradePosts.$inferSelect

// ── stock_holdings ───────────────────────────────────────────────────────────
// Simulated share lots backing the paper-trading account. Sourced from a SELL_PUT
// assignment (wheel strategy), a direct LONG trade, or a direct SHORT trade.
// `shares` is SIGNED: positive = long, negative = short — this makes
// (currentPrice - costBasis) * shares correct for both directions uniformly.
// A PUT_ASSIGNMENT lot is closed out when a later SELL_CALL against the same
// ticker is itself assigned (shares "called away"). LONG/SHORT lots are closed
// manually via POST /feed/holdings/:id/close. Cost basis is the gross
// strike/entry price — option premium is booked separately as realized P&L on
// the originating trade_posts row, so folding it into cost basis here would
// double-count it (see trade-post-expiry.ts).

export const stockHoldings = pgTable('stock_holdings', {
  id:               serial('id').primaryKey(),
  userId:           integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  ticker:           text('ticker').notNull(),
  shares:           integer('shares').notNull(), // signed: positive=long, negative=short
  costBasis:        numeric('cost_basis').notNull(),
  source:           text('source').notNull().default('PUT_ASSIGNMENT'), // PUT_ASSIGNMENT | LONG_TRADE | SHORT_TRADE
  status:           text('status').notNull().default('OPEN'), // OPEN | CALLED_AWAY | CLOSED
  openedFromPostId: integer('opened_from_post_id').references(() => tradePosts.id, { onDelete: 'set null' }),
  closedByPostId:   integer('closed_by_post_id').references(() => tradePosts.id, { onDelete: 'set null' }),
  realizedPnl:      numeric('realized_pnl'),
  notes:            text('notes'),
  openedAt:         timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt:         timestamp('closed_at', { withTimezone: true }),
}, t => ({
  userIdx:   index('idx_stock_holdings_user_id').on(t.userId),
  tickerIdx: index('idx_stock_holdings_ticker').on(t.ticker),
}))

export const insertStockHoldingSchema = createInsertSchema(stockHoldings).omit({ id: true, openedAt: true })
export type InsertStockHolding = z.infer<typeof insertStockHoldingSchema>
export type StockHolding = typeof stockHoldings.$inferSelect

// ── likes ─────────────────────────────────────────────────────────────────────

export const likes = pgTable('likes', {
  id:        serial('id').primaryKey(),
  postId:    integer('post_id').notNull().references(() => tradePosts.id, { onDelete: 'cascade' }),
  userId:    integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueLike: unique().on(t.postId, t.userId),
  postIdx:    index('idx_likes_post_id').on(t.postId),
  userIdx:    index('idx_likes_user_id').on(t.userId),
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
}, t => ({
  postIdx: index('idx_comments_post_id').on(t.postId),
}))

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
  // Rollups summed across portfolio_account_summaries at ingest time — cheap
  // read access for the UI without a join. Source of truth is the per-account table.
  cashBalance:  numeric('cash_balance'),
  cryptoValue:  numeric('crypto_value'),
})

export type PortfolioSnapshot = typeof portfolioSnapshots.$inferSelect
export type InsertPortfolioSnapshot = typeof portfolioSnapshots.$inferInsert

// ── portfolio_account_summaries ─────────────────────────────────────────────
// One row per account per snapshot — the ACCOUNT SUMMARY CSV section, which
// carries per-account cash/margin figures the COMBINED row doesn't (e.g. a
// margin account can show negative cash while an IRA can't).

export const portfolioAccountSummaries = pgTable('portfolio_account_summaries', {
  id:              serial('id').primaryKey(),
  snapshotId:      integer('snapshot_id').notNull().references(() => portfolioSnapshots.id, { onDelete: 'cascade' }),
  account:         text('account').notNull(),
  nickname:        text('nickname'),
  type:            text('type'),              // 'individual' | 'ira_traditional' etc.
  totalValue:      numeric('total_value'),
  equityValue:     numeric('equity_value'),
  optionsValue:    numeric('options_value'),
  cryptoValue:     numeric('crypto_value'),
  eventContracts:  numeric('event_contracts'),
  cash:            numeric('cash'),            // can be negative on margin
  marginUsed:      numeric('margin_used'),      // null/N-A for cash-only accounts
  buyingPower:     numeric('buying_power'),
  unleveragedBp:   numeric('unleveraged_bp'),
}, t => ({
  snapshotIdx: index('portfolio_account_summaries_snapshot_idx').on(t.snapshotId),
}))

export type PortfolioAccountSummary = typeof portfolioAccountSummaries.$inferSelect
export type InsertPortfolioAccountSummary = typeof portfolioAccountSummaries.$inferInsert

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
  extHoursPrice:    numeric('ext_hours_price'),
  marketValue:      numeric('market_value'),
  costBasis:        numeric('cost_basis'),
  unrealizedPnL:    numeric('unrealized_pnl'),
  pnlPct:           numeric('pnl_pct'),
  dayChangePct:     numeric('day_change_pct'),
  bid:              numeric('bid'),
  ask:              numeric('ask'),
  prevClose:        numeric('prev_close'),
}, t => ({
  snapshotIdx: index('portfolio_positions_snapshot_idx').on(t.snapshotId),
}))

export type PortfolioPosition = typeof portfolioPositions.$inferSelect
export type InsertPortfolioPosition = typeof portfolioPositions.$inferInsert

// ── portfolio_equity_fundamentals ───────────────────────────────────────────
// The EQUITY FUNDAMENTALS CSV section — previously parsed and discarded
// entirely. Kept per-symbol (not per-account) to mirror the CSV. Useful as a
// fallback for small-cap/derivative-ETF holdings not in the app's own
// fmp_fundamentals canonical universe (see .claude/skills/db-patterns.md).

export const portfolioEquityFundamentals = pgTable('portfolio_equity_fundamentals', {
  id:                 serial('id').primaryKey(),
  snapshotId:         integer('snapshot_id').notNull().references(() => portfolioSnapshots.id, { onDelete: 'cascade' }),
  symbol:             text('symbol').notNull(),
  open:               numeric('open'),
  high:               numeric('high'),
  low:                numeric('low'),
  volume:             numeric('volume'),
  avgVol2w:           numeric('avg_vol_2w'),
  marketCap:          numeric('market_cap'),
  peRatio:            numeric('pe_ratio'),
  pbRatio:            numeric('pb_ratio'),
  week52High:         numeric('week52_high'),
  week52Low:          numeric('week52_low'),
  sharesOutstanding:  numeric('shares_outstanding'),
  divPerShare:        numeric('div_per_share'),
  divYield:            numeric('div_yield'),
  sector:             text('sector'),
  industry:           text('industry'),
}, t => ({
  snapshotIdx: index('portfolio_equity_fundamentals_snapshot_idx').on(t.snapshotId),
}))

export type PortfolioEquityFundamental = typeof portfolioEquityFundamentals.$inferSelect
export type InsertPortfolioEquityFundamental = typeof portfolioEquityFundamentals.$inferInsert

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
  adjMark:        numeric('adj_mark'),
  currentValue:   numeric('current_value'),   // CSV's own per-contract current value
  unrealizedPnL:  numeric('unrealized_pnl'),
  pnlPct:         numeric('pnl_pct'),
  bid:            numeric('bid'),
  ask:            numeric('ask'),
  prevClose:      numeric('prev_close'),
  iv:             numeric('iv'),
  delta:          numeric('delta'),
  gamma:          numeric('gamma'),
  theta:          numeric('theta'),
  vega:           numeric('vega'),
  openInterest:   numeric('open_interest'),
  volume:         numeric('volume'),
}, t => ({
  snapshotIdx: index('portfolio_options_snapshot_idx').on(t.snapshotId),
}))

export type PortfolioOption = typeof portfolioOptions.$inferSelect
export type InsertPortfolioOption = typeof portfolioOptions.$inferInsert

// ── portfolio_orders ──────────────────────────────────────────────────────────

export const portfolioOrders = pgTable('portfolio_orders', {
  id:                 serial('id').primaryKey(),
  snapshotId:         integer('snapshot_id').notNull().references(() => portfolioSnapshots.id, { onDelete: 'cascade' }),
  orderId:            text('order_id'),
  account:            text('account').notNull(),
  symbol:             text('symbol').notNull(),
  side:               text('side'),             // equity: 'buy'|'sell'; option: 'debit'|'credit'
  orderType:          text('order_type'),        // equity: 'market'|'limit'|'stop'; option: strategy e.g. 'short_put'
  state:              text('state'),             // 'filled' | 'cancelled' | 'pending' etc.
  quantity:           numeric('quantity'),
  cumulativeQty:      numeric('cumulative_qty'),  // equity: Cumulative Qty
  processedQty:       numeric('processed_qty'),   // option: Processed Qty
  canceledQty:        numeric('canceled_qty'),    // option: Canceled Qty
  limitPrice:         numeric('limit_price'),      // equity only
  stopPrice:          numeric('stop_price'),       // equity only
  avgFillPrice:       numeric('avg_fill_price'),
  premium:            numeric('premium'),          // option: Premium (per order)
  processedPremium:   numeric('processed_premium'), // option: Processed Premium
  fees:               numeric('fees'),
  timeInForce:        text('time_in_force'),
  marketHours:        text('market_hours'),
  placedAgent:        text('placed_agent'),
  createdAt:          timestamp('created_at', { withTimezone: true }),
  lastTransactionAt:  timestamp('last_transaction_at', { withTimezone: true }),
  isOption:           boolean('is_option').notNull().default(false),
  optionStrike:       numeric('option_strike'),
  optionExpiration:   date('option_expiration'),
  optionSide:         text('option_side'),      // 'call' | 'put'
  legSide:            text('leg_side'),         // option: 'buy' | 'sell'
  legEffect:          text('leg_effect'),       // option: 'open' | 'close' — key for wheel-cycle chaining
  // Non-order transaction rows (dividends, cash bonuses, assignments missing from the order
  // API) reuse this table instead of a separate one. orderType tags the row kind: 'assignment'
  // | 'dividend' | 'cash_bonus' alongside the existing 'market'/'limit'/option-strategy values.
  amount:             numeric('amount'),         // total cash value for dividend/cash_bonus rows
  source:             text('source'),            // provenance for non-API rows, e.g. 'get_equity_tax_lots (open lot)'
  confidence:         text('confidence'),        // free-text confidence note for estimated rows
}, t => ({
  snapshotIdx: index('portfolio_orders_snapshot_idx').on(t.snapshotId),
}))

export type PortfolioOrder = typeof portfolioOrders.$inferSelect
export type InsertPortfolioOrder = typeof portfolioOrders.$inferInsert

// ── portfolio_transactions ──────────────────────────────────────────────────────
// The flat txn-export format (export_rbh_transactions.py), NOT tied to a
// portfolio_snapshots row — unlike holdings (which fully replace on each import,
// so "latest snapshot" = current state), transaction history accumulates across
// imports. txnId is the dedupe key: a "recent" export (small, latest activity)
// and a "cumulative" export (full history) both upsert into this same table via
// ON CONFLICT (txn_id) — whichever runs first wins no duplicates, and importing
// cumulative after recent (or vice versa) just backfills whatever's missing.

export const portfolioTransactions = pgTable('portfolio_transactions', {
  id:         serial('id').primaryKey(),
  txnId:      text('txn_id').notNull(),
  account:    text('account').notNull(),
  symbol:     text('symbol').notNull(),
  txnType:    text('txn_type'),      // 'equity_order' | 'option_order' | 'assignment_buy' | 'assignment_sell' | 'realized_close' | 'dividend'
  category:   text('category'),      // 'Stocks (capital gains)' | 'Sell Puts' | 'Sell Calls' | 'Options — Put (close)' | 'Options — Call (close)' | 'Long Calls' | 'Dividends' | 'cash_bonus'
  side:       text('side'),          // 'buy' | 'sell'
  quantity:   numeric('quantity'),
  price:      numeric('price'),
  amount:     numeric('amount'),
  txnDate:    timestamp('txn_date', { withTimezone: true }),
  source:     text('source'),        // e.g. 'get_equity_orders', 'get_option_orders'
  confidence: text('confidence'),
  importedAt: timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  txnIdUnique: unique('portfolio_transactions_txn_id_unique').on(t.txnId),
  symbolIdx:   index('portfolio_transactions_symbol_idx').on(t.symbol),
}))

export type PortfolioTransaction = typeof portfolioTransactions.$inferSelect
export type InsertPortfolioTransaction = typeof portfolioTransactions.$inferInsert

// ── portfolio_ticker_earnings ───────────────────────────────────────────────────
// ticker-earnings-summary export — cumulative YTD realized/unrealized P&L broken
// out per ticker per account, already computed upstream by the export script.
// Each import supersedes the prior figures for that (account, ticker) pair via
// ON CONFLICT DO UPDATE (the export is always cumulative-to-date, never a delta).

export const portfolioTickerEarnings = pgTable('portfolio_ticker_earnings', {
  id:                serial('id').primaryKey(),
  account:           text('account').notNull(),   // account nickname, e.g. 'FILDI', or 'TOTAL'
  ticker:            text('ticker').notNull(),
  totalUnrealized:   numeric('total_unrealized'),
  totalRealized:     numeric('total_realized'),
  totalEarned:       numeric('total_earned'),
  sellPut:           numeric('sell_put'),
  sellCall:          numeric('sell_call'),
  longCall:          numeric('long_call'),
  longPut:           numeric('long_put'),
  dividends:         numeric('dividends'),
  stocksRealized:    numeric('stocks_realized'),
  stocksUnrealized:  numeric('stocks_unrealized'),
  totalStocks:       numeric('total_stocks'),
  importedAt:        timestamp('imported_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  accountTickerUnique: unique('portfolio_ticker_earnings_account_ticker_unique').on(t.account, t.ticker),
}))

export type PortfolioTickerEarning = typeof portfolioTickerEarnings.$inferSelect
export type InsertPortfolioTickerEarning = typeof portfolioTickerEarnings.$inferInsert

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
  yahooTrailingPe:             numeric('yahoo_trailing_pe'),
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
  yahooDividendYield:          numeric('yahoo_dividend_yield'),

  // incomeStatementHistory module (most recent annual 10-K)
  yahooAnnualTotalRevenue:  numeric('yahoo_annual_total_revenue'),
  yahooAnnualGrossProfit:   numeric('yahoo_annual_gross_profit'),
  yahooAnnualEbit:          numeric('yahoo_annual_ebit'),
  yahooAnnualNetIncome:     numeric('yahoo_annual_net_income'),
  yahooAnnualRevenueYoy:      numeric('yahoo_annual_revenue_yoy'),       // computed: (yr0-yr1)/|yr1|
  yahooAnnualRevenueYoyPrior: numeric('yahoo_annual_revenue_yoy_prior'),  // computed: (yr1-yr2)/|yr2|

  // balanceSheetHistory module (most recent annual 10-K)
  yahooAnnualCash:          numeric('yahoo_annual_cash'),
  yahooAnnualTotalDebt:     numeric('yahoo_annual_total_debt'),   // longTermDebt + shortLongTermDebt
  yahooAnnualTotalEquity:   numeric('yahoo_annual_total_equity'),

  // cashflowStatementHistory module (most recent annual 10-K)
  yahooAnnualOperatingCashFlow:  numeric('yahoo_annual_operating_cash_flow'),
  yahooAnnualCapex:              numeric('yahoo_annual_capex'),           // stored positive
  yahooAnnualFreeCashFlow:       numeric('yahoo_annual_free_cash_flow'),  // computed: opCF + capex

  // computed from fundamentalsTimeSeries
  yahooEpsGrowth:               numeric('yahoo_eps_growth'),              // computed: (eps0-eps1)/|eps1|
  yahooSharesOutstandingPrior:  numeric('yahoo_shares_outstanding_prior'),
  yahooEffectiveTaxRate:        numeric('yahoo_effective_tax_rate'),      // taxRateForCalcs (decimal)
  yahooInterestExpense:         numeric('yahoo_interest_expense'),        // fts0.interestExpense
  yahooQuarterlyOcf:            numeric('yahoo_quarterly_ocf'),           // most recent quarter operatingCashFlow
  yahooRoic:                    numeric('yahoo_roic'),                    // computed: NOPAT / InvestedCapital
  yahooWacc:                    numeric('yahoo_wacc'),                    // computed: approxWACC (rf=4.5%, ERP=5.5%)
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
  edgarDepreciationAmortization: numeric('edgar_depreciation_amortization'),
})

export const insertEdgarFundamentalsSchema = createInsertSchema(edgarFundamentals).omit({ fetchedAt: true })
export type InsertEdgarFundamentals = z.infer<typeof insertEdgarFundamentalsSchema>
export type EdgarFundamentalsRow = typeof edgarFundamentals.$inferSelect

// ── edgar_statement_history ─────────────────────────────────────────────────────
// Multi-year (up to 5 annual 10-K/FY) SEC XBRL line items per ticker, for the
// Accounting Statements UI tab. Distinct from edgar_fundamentals above, which only
// keeps the single latest value per concept for triangulation scoring.
// Written by: edgar-client.ts fetchEdgarStatementHistory() → routes/edgar-statements.ts

export const edgarStatementHistory = pgTable('edgar_statement_history', {
  ticker:        text('ticker').notNull(),
  fiscalYear:    integer('fiscal_year').notNull(),
  statementType: text('statement_type').notNull(), // 'income' | 'balance' | 'cashflow'
  lineItem:      text('line_item').notNull(),
  value:         numeric('value').notNull(),
  filedDate:     date('filed_date').notNull(),
  fetchedAt:     timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  pk: primaryKey({ columns: [t.ticker, t.fiscalYear, t.statementType, t.lineItem] }),
}))

export const insertEdgarStatementHistorySchema = createInsertSchema(edgarStatementHistory).omit({ fetchedAt: true })
export type InsertEdgarStatementHistory = z.infer<typeof insertEdgarStatementHistorySchema>
export type EdgarStatementHistoryRow = typeof edgarStatementHistory.$inferSelect

// ── finnhub_fundamentals ──────────────────────────────────────────────────────
// Raw Finnhub /stock/metric?metric=all data per ticker. One row per ticker.
// Staging/audit table only — ticker_fundamentals is the scorer's source.
// Written by: finnhub-client.ts → backfill-finnhub.ts

export const finnhubFundamentals = pgTable('finnhub_fundamentals', {
  ticker:    text('ticker').primaryKey(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),

  // Valuation
  finnhubPeRatio:          numeric('finnhub_pe_ratio'),
  finnhubPegRatio:         numeric('finnhub_peg_ratio'),          // forwardPEG — forward-looking, unlike yahoo/fmp's trailing PEG
  finnhubPbRatio:          numeric('finnhub_pb_ratio'),
  finnhubPsRatio:          numeric('finnhub_ps_ratio'),
  finnhubPriceToBook:      numeric('finnhub_price_to_book'),       // pbAnnual
  finnhubEv:               numeric('finnhub_ev'),
  finnhubMarketCap:        numeric('finnhub_market_cap'),

  // Margins (stored as decimals, e.g. 0.25 = 25%)
  finnhubGrossMargin:      numeric('finnhub_gross_margin'),
  finnhubOperatingMargin:  numeric('finnhub_operating_margin'),
  finnhubNetMargin:        numeric('finnhub_net_margin'),
  finnhubFcfMargin:        numeric('finnhub_fcf_margin'),

  // Returns (stored as decimals)
  finnhubReturnOnEquity:   numeric('finnhub_return_on_equity'),
  finnhubReturnOnAssets:   numeric('finnhub_return_on_assets'),
  finnhubRoic:             numeric('finnhub_roic'),

  // Growth (stored as decimals)
  finnhubRevenueGrowth:    numeric('finnhub_revenue_growth'),
  finnhubEpsGrowth:        numeric('finnhub_eps_growth'),

  // Leverage (stored as decimals)
  finnhubDebtToEquity:          numeric('finnhub_debt_to_equity'),
  finnhubLongTermDebtToEquity:  numeric('finnhub_long_term_debt_to_equity'),
  finnhubNetDebtToEquity:       numeric('finnhub_net_debt_to_equity'),

  // Liquidity
  finnhubCurrentRatio:     numeric('finnhub_current_ratio'),
  finnhubQuickRatio:       numeric('finnhub_quick_ratio'),

  // Per-share
  finnhubFcfPerShare:      numeric('finnhub_fcf_per_share'),
  finnhubBookValue:        numeric('finnhub_book_value'),
  finnhubTangibleBookValuePerShare: numeric('finnhub_tangible_book_value_per_share'),
  finnhubBeta:             numeric('finnhub_beta'),
  finnhubEps:              numeric('finnhub_eps'),
  finnhubEbitPerShare:     numeric('finnhub_ebit_per_share'),
  finnhubEarningsPerShare: numeric('finnhub_earnings_per_share'),

  // Price range
  finnhub52weekHigh:       numeric('finnhub_52week_high'),
  finnhub52weekLow:        numeric('finnhub_52week_low'),

  // Income / yield
  finnhubDividendYield:    numeric('finnhub_dividend_yield'),
})

export const insertFinnhubFundamentalsSchema = createInsertSchema(finnhubFundamentals).omit({ fetchedAt: true })
export type InsertFinnhubFundamentals = z.infer<typeof insertFinnhubFundamentalsSchema>
export type FinnhubFundamentalsRow = typeof finnhubFundamentals.$inferSelect

// ── fmp_fundamentals ──────────────────────────────────────────────────────────
// Raw Financial Modeling Prep data per ticker. One row per ticker.
// Staging/audit table only — ticker_fundamentals is the scorer's source.
// Written by: fmp-client.ts → backfill-fmp.ts

export const fmpFundamentals = pgTable('fmp_fundamentals', {
  ticker:    text('ticker').primaryKey(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),

  // Valuation
  fmpPeRatio:           numeric('fmp_pe_ratio'),
  fmpPegRatio:          numeric('fmp_peg_ratio'),
  fmpForwardPe:         numeric('fmp_forward_pe'),
  fmpEvEbitda:          numeric('fmp_ev_ebitda'),
  fmpEvRevenue:         numeric('fmp_ev_revenue'),
  fmpPriceToBook:       numeric('fmp_price_to_book'),
  fmpPriceToSales:      numeric('fmp_price_to_sales'),
  fmpAnalystTargetPrice: numeric('fmp_analyst_target_price'),

  // Growth
  fmpRevenueGrowthYoY:       numeric('fmp_revenue_growth_yoy'),
  fmpRevenueGrowthYoyPrior:  numeric('fmp_revenue_growth_yoy_prior'),
  fmpEpsGrowth:              numeric('fmp_eps_growth'),
  fmpEarningsPerShare:       numeric('fmp_earnings_per_share'),

  // Margins & Returns (stored as decimals)
  fmpGrossMargin:       numeric('fmp_gross_margin'),
  fmpOperatingMargin:   numeric('fmp_operating_margin'),
  fmpNetMargin:         numeric('fmp_net_margin'),
  fmpReturnOnEquity:    numeric('fmp_return_on_equity'),
  fmpReturnOnAssets:    numeric('fmp_return_on_assets'),
  fmpEffectiveTaxRate:  numeric('fmp_effective_tax_rate'),

  // Income statement
  fmpTotalRevenue:      numeric('fmp_total_revenue'),
  fmpNetIncome:         numeric('fmp_net_income'),
  fmpEbitda:            numeric('fmp_ebitda'),
  fmpEbit:              numeric('fmp_ebit'),
  fmpInterestExpense:   numeric('fmp_interest_expense'),  // stored positive
  fmpFreeCashFlow:      numeric('fmp_free_cash_flow'),

  // Balance sheet & liquidity
  fmpCurrentRatio:               numeric('fmp_current_ratio'),
  fmpDebtToEquity:               numeric('fmp_debt_to_equity'),
  fmpTotalDebt:                  numeric('fmp_total_debt'),
  fmpTotalStockholdersEquity:    numeric('fmp_total_stockholders_equity'),
  fmpCashAndEquivalents:         numeric('fmp_cash_and_equivalents'),
  fmpTotalAssets:                numeric('fmp_total_assets'),
  fmpGrossProfit:                numeric('fmp_gross_profit'),
  fmpTangibleBookValuePerShare:  numeric('fmp_tangible_book_value_per_share'),
  fmpWacc:                       numeric('fmp_wacc'),
  fmpRoic:                       numeric('fmp_roic'),

  // Cash flow
  fmpQuarterlyOperatingCashFlow: numeric('fmp_quarterly_operating_cash_flow'),
  fmpAnnualOperatingCashFlow:    numeric('fmp_annual_operating_cash_flow'),

  // Share data
  fmpSharesOutstanding:      numeric('fmp_shares_outstanding'),
  fmpSharesOutstandingPrior: numeric('fmp_shares_outstanding_prior'),
  fmpDividendYield:          numeric('fmp_dividend_yield'),
  fmpBeta:                   numeric('fmp_beta'),
})

export const insertFmpFundamentalsSchema = createInsertSchema(fmpFundamentals).omit({ fetchedAt: true })
export type InsertFmpFundamentals = z.infer<typeof insertFmpFundamentalsSchema>
export type FmpFundamentalsRow = typeof fmpFundamentals.$inferSelect

// ── polygon_fundamentals ──────────────────────────────────────────────────────
// Raw Polygon.io financials data per ticker. One row per ticker.
// Staging/audit table only — ticker_fundamentals is the scorer's source.
// Written by: polygon-client.ts → backfill-polygon.ts

export const polygonFundamentals = pgTable('polygon_fundamentals', {
  ticker:    text('ticker').primaryKey(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),

  // Income statement
  polygonTotalRevenue:              numeric('polygon_total_revenue'),
  polygonNetIncome:                 numeric('polygon_net_income'),
  polygonInterestExpense:           numeric('polygon_interest_expense'),  // stored positive

  // Computed margins
  polygonGrossMargin:               numeric('polygon_gross_margin'),
  polygonOperatingMargin:           numeric('polygon_operating_margin'),

  // Balance sheet
  polygonTotalDebt:                 numeric('polygon_total_debt'),
  polygonTotalStockholdersEquity:   numeric('polygon_total_stockholders_equity'),

  // Cash flow
  polygonQuarterlyOperatingCashFlow: numeric('polygon_quarterly_operating_cash_flow'),
})

export const insertPolygonFundamentalsSchema = createInsertSchema(polygonFundamentals).omit({ fetchedAt: true })
export type InsertPolygonFundamentals = z.infer<typeof insertPolygonFundamentalsSchema>
export type PolygonFundamentalsRow = typeof polygonFundamentals.$inferSelect

// ── av_fundamentals ───────────────────────────────────────────────────────────
// Raw Alpha Vantage OVERVIEW data per ticker. One row per ticker.
// Staging/audit table only — ticker_fundamentals is the scorer's source.
// Written by: alpha-vantage-client.ts → backfill-av.ts

export const avFundamentals = pgTable('av_fundamentals', {
  ticker:    text('ticker').primaryKey(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),

  // Valuation
  avPeRatio:            numeric('av_pe_ratio'),
  avPegRatio:           numeric('av_peg_ratio'),
  avForwardPe:          numeric('av_forward_pe'),
  avPbRatio:            numeric('av_pb_ratio'),
  avDividendYield:      numeric('av_dividend_yield'),
  avAnalystTargetPrice: numeric('av_analyst_target_price'),

  // Margins & Returns (stored as decimals)
  avNetMargin:          numeric('av_net_margin'),
  avOperatingMargin:    numeric('av_operating_margin'),
  avReturnOnEquity:     numeric('av_return_on_equity'),

  // Income statement
  avTotalRevenue:       numeric('av_total_revenue'),
  avEbitda:             numeric('av_ebitda'),

  // Risk
  avBeta:               numeric('av_beta'),
})

export const insertAvFundamentalsSchema = createInsertSchema(avFundamentals).omit({ fetchedAt: true })
export type InsertAvFundamentals = z.infer<typeof insertAvFundamentalsSchema>
export type AvFundamentalsRow = typeof avFundamentals.$inferSelect

// ── source_fundamentals ───────────────────────────────────────────────────────
// Field-level cross-source store. One row per (ticker, source, field).
// Enables "Yahoo returned 0.72 for NVDA grossMargin vs FMP returned 0.71" queries.
// Populated by: populate-source-fundamentals.ts and backfill scripts.
// NOT related to source_ticker_map (which tracks boolean source availability).

export const sourceFundamentals = pgTable('source_fundamentals', {
  ticker:    text('ticker').notNull(),
  source:    text('source').notNull(),  // 'yahoo' | 'fmp' | 'edgar' | 'finnhub' | 'polygon' | 'alpha_vantage'
  field:     text('field').notNull(),   // camelCase field name e.g. 'grossMargin', 'forwardPe'
  value:     numeric('value').notNull(),
  fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ticker, t.source, t.field] }),
}))

export const insertSourceFundamentalsSchema = createInsertSchema(sourceFundamentals).omit({ fetchedAt: true })
export type InsertSourceFundamentals = z.infer<typeof insertSourceFundamentalsSchema>
export type SourceFundamentalsRow = typeof sourceFundamentals.$inferSelect

// ── field_provenance ──────────────────────────────────────────────────────────
// One row per (ticker, field). Written by merge-trusted.ts after each merge run.
// Records which source won for each field, the winning value, and whether any
// sources disagreed (divergent). is_override = true when a manual_overrides row
// forced the winner. Read by GET /api/fundamentals/provenance/:ticker for the UI.

export const fieldProvenance = pgTable('field_provenance', {
  ticker:        text('ticker').notNull(),
  field:         text('field').notNull(),        // camelCase e.g. 'grossMargin'
  winningSource: text('winning_source').notNull(),
  winningValue:  numeric('winning_value'),
  isOverride:    boolean('is_override').notNull().default(false),
  divergent:     boolean('divergent').notNull().default(false),
  fetchedAt:     timestamp('fetched_at', { withTimezone: true }).notNull(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ticker, t.field] }),
}))

export const insertFieldProvenanceSchema = createInsertSchema(fieldProvenance).omit({ updatedAt: true })
export type InsertFieldProvenance = z.infer<typeof insertFieldProvenanceSchema>
export type FieldProvenanceRow = typeof fieldProvenance.$inferSelect

// ── manual_overrides ──────────────────────────────────────────────────────────
// One row per (ticker, field). Admin-set overrides that force merge-trusted.ts
// to use a specific source (or a literal value) for a given ticker+field.
// Checked before FIELD_DEFS priority in merge-trusted.ts.
// Written by PUT /api/fundamentals/override; cleared by DELETE.

export const manualOverrides = pgTable('manual_overrides', {
  ticker:          text('ticker').notNull(),
  field:           text('field').notNull(),
  overrideSource:  text('override_source').notNull(), // source name, or 'manual' for literal value
  overrideValue:   numeric('override_value'),          // null = use best value from overrideSource
  note:            text('note'),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ticker, t.field] }),
}))

export const insertManualOverridesSchema = createInsertSchema(manualOverrides).omit({ createdAt: true })
export type InsertManualOverrides = z.infer<typeof insertManualOverridesSchema>
export type ManualOverridesRow = typeof manualOverrides.$inferSelect

// ── Explain cache ─────────────────────────────────────────────────────────────
// Stores AI-generated score explanations keyed by ticker + scoreType + scoreHash.
// scoreHash is a deterministic string of the key inputs; changes when score changes,
// causing a cache miss and regeneration on the next explain request.
export const explainCache = pgTable('explain_cache', {
  ticker:        text('ticker').notNull(),
  scoreType:     text('score_type').notNull(),    // "fundamental" | "technical"
  scoreHash:     text('score_hash').notNull(),
  explanation:   text('explanation').notNull(),
  generatedAt:   timestamp('generated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.ticker, t.scoreType] }),
}));

export type ExplainCacheRow = typeof explainCache.$inferSelect

// ── ai_usage_log ──────────────────────────────────────────────────────────────
// Per-request audit trail for Explain AI (who asked, for what ticker, cache hit
// or a real Haiku call). Separate from explain_cache (which stores content, not
// attribution) and from api_usage (which is a vendor-level daily counter, not
// per-user). Exists so a future multi-user deployment can see per-account usage
// without storing prompt/explanation text here — metadata only.
export const aiUsageLog = pgTable('ai_usage_log', {
  id:          serial('id').primaryKey(),
  userId:      integer('user_id').notNull().references(() => users.id),
  ticker:      text('ticker').notNull(),
  surfaceType: text('surface_type').notNull(),   // "fundamental" | "technical" | "options" | ...
  cached:      boolean('cached').notNull(),
  /** Anthropic usage.input_tokens — null on cache hits / legacy rows */
  inputTokens: integer('input_tokens'),
  /** Anthropic usage.output_tokens — null on cache hits / legacy rows */
  outputTokens: integer('output_tokens'),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  userIdx: index('ai_usage_log_user_idx').on(t.userId, t.createdAt),
  // Supports the retention prune's range-delete (WHERE created_at < ...) across all
  // users — the composite index above can't serve that since userId isn't filtered.
  createdAtIdx: index('ai_usage_log_created_at_idx').on(t.createdAt),
}));

export type AiUsageLogRow = typeof aiUsageLog.$inferSelect

// ── enrichment_runs ───────────────────────────────────────────────────────────
// One row per enrichment invocation (full nightly-enrichment.ts OR daily maintain.mjs).
// trigger: scheduled (in-process scheduler) | maintain (LaunchAgent lean daily) |
//          maintain_full (maintain ≥4d catch-up) | manual (CLI).
// Written at the end of a run (or
// immediately on a setup-phase failure, before any per-source fetching starts) so
// a run's outcome is queryable instead of living only in the per-day log file.
// perSource shape: { [source]: { targeted, fetched, nodata, failed, budgetSkipped } }.
// coverageBefore/After are % of active-ticker fields non-null, same calc as
// GET /api/admin/data-health, so the numbers are directly comparable.
export const enrichmentRuns = pgTable('enrichment_runs', {
  id:                 serial('id').primaryKey(),
  startedAt:          timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt:         timestamp('finished_at', { withTimezone: true }),
  status:             text('status').notNull(),      // "success" | "partial" | "failed"
  trigger:            text('trigger').notNull(),      // "scheduled" | "manual" | "maintain" | "maintain_full"
  perSource:          jsonb('per_source'),
  coverageBefore:     numeric('coverage_before'),
  coverageAfter:      numeric('coverage_after'),
  error:              text('error'),
  flagAuditOrphaned:  integer('flag_audit_orphaned'),
  flagAuditMissing:   integer('flag_audit_missing'),
}, (t) => ({
  startedAtIdx: index('enrichment_runs_started_at_idx').on(t.startedAt),
}));

export type EnrichmentRunRow = typeof enrichmentRuns.$inferSelect

// ── fetch_queue ───────────────────────────────────────────────────────────────
// Ad-hoc re-fetch requests queued from the Stock DB tab popup (e.g. admin sees a
// null/suspect cell and wants a specific source refetched now, without waiting
// for nightly enrichment). field is stored for display only — the fetch
// functions operate per (ticker, source), so processing dedupes on that pair.
export const fetchQueue = pgTable('fetch_queue', {
  id:          serial('id').primaryKey(),
  ticker:      text('ticker').notNull(),
  field:       text('field').notNull(),
  source:      text('source').notNull(), // yahoo | edgar | finnhub | polygon | alpha_vantage | fmp
  status:      text('status').notNull().default('pending'), // pending | running | done | failed
  queuedAt:    timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  error:       text('error'),
}, (t) => ({
  statusIdx: index('fetch_queue_status_idx').on(t.status),
}));

export type FetchQueueRow = typeof fetchQueue.$inferSelect

// ── feedback ──────────────────────────────────────────────────────────────────

export const feedback = pgTable('feedback', {
  id:        serial('id').primaryKey(),
  userId:    integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  message:   text('message').notNull(),
  page:      text('page'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  createdAtIdx: index('idx_feedback_created_at').on(t.createdAt),
}))

export const insertFeedbackSchema = createInsertSchema(feedback).omit({ id: true, createdAt: true })
export type InsertFeedback = z.infer<typeof insertFeedbackSchema>
export type Feedback = typeof feedback.$inferSelect

// ── model_recs ────────────────────────────────────────────────────────────────
// Model accountability: one row per (weekly snapshot, ticker, side) — the option
// the model would recommend SELLING that week, captured with full scoring context.
// Graded at expiry by the Saturday resolver using prices_historical closes:
// pnlPerShare = premium − intrinsic; WIN iff > 0. Universe = distinct watchlist
// tickers across all users at snapshot time (never the full DB universe).

export const modelRecs = pgTable('model_recs', {
  id:              serial('id').primaryKey(),
  snapshotDate:    date('snapshot_date').notNull(),
  ticker:          text('ticker').notNull(),
  side:            text('side').notNull(),            // put | call
  expiry:          date('expiry').notNull(),
  strike:          numeric('strike').notNull(),
  spot:            numeric('spot').notNull(),          // stock price at rec time
  premium:         numeric('premium').notNull(),       // bid (or lastPrice fallback when market closed)
  bidIsLive:       boolean('bid_is_live').notNull().default(true),
  incomePct:       numeric('income_pct'),
  weeklyIncomePct: numeric('weekly_income_pct'),
  delta:           numeric('delta'),
  strikeIv:        numeric('strike_iv'),
  dte:             numeric('dte'),
  optionScore:     numeric('option_score').notNull(),
  componentScores: jsonb('component_scores').notNull(), // per-component score + weight (audit trail)
  dataQuality:     numeric('data_quality'),
  volRegime:       text('vol_regime').notNull(),        // LOW_VOL | BASELINE | ELEVATED | EXTREME
  macroRegime:     text('macro_regime'),                // latest market_regime.regime at rec time
  tiltApplied:     jsonb('tilt_applied'),               // { factor, weights } actually used
  // Grading (filled by the Saturday resolver)
  status:          text('status').notNull().default('PENDING'), // PENDING | WIN | LOSS | NO_DATA
  settleClose:     numeric('settle_close'),             // close on/before expiry
  intrinsic:       numeric('intrinsic'),
  pnlPerShare:     numeric('pnl_per_share'),
  pnlPct:          numeric('pnl_pct'),                  // put: /strike (CSP collateral); call: /spot
  gradedAt:        timestamp('graded_at', { withTimezone: true }),
  createdAt:       timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  snapshotUnique: unique('idx_model_recs_snapshot').on(t.snapshotDate, t.ticker, t.side),
  pendingIdx:     index('idx_model_recs_pending').on(t.status, t.expiry),
  tickerIdx:      index('idx_model_recs_ticker').on(t.ticker),
}))

export type ModelRec = typeof modelRecs.$inferSelect
export type InsertModelRec = typeof modelRecs.$inferInsert

// ── hotlist_snapshots ─────────────────────────────────────────────────────────
// Daily capture of Live-tab hotlist GO/WATCH calls ('NO' rows are not persisted).
// Headline grade is strike safety over horizonDays: dip fails if the low breaches
// strikeRef, rally fails if the high does. Forward returns (1d/5d/10d) are kept
// alongside as secondary context — dip expects a bounce, rally expects a fade.

export const hotlistSnapshots = pgTable('hotlist_snapshots', {
  id:           serial('id').primaryKey(),
  snapshotDate: date('snapshot_date').notNull(),
  ticker:       text('ticker').notNull(),
  side:         text('side').notNull(),      // dip | rally
  signal:       text('signal').notNull(),    // GO | WATCH
  price:        numeric('price').notNull(),
  rsi:          numeric('rsi'),
  mfi:          numeric('mfi'),
  ivCurrent:    numeric('iv_current'),
  // Graded on two axes side by side: strike safety (did a put you'd have sold that
  // day survive?) is the headline, forward returns are secondary context. A ticker
  // can round-trip to a positive 5d return after breaching the strike mid-horizon —
  // that's a loss for a put seller and a win on fwdReturn5d, hence both.
  entryVerdict:   text('entry_verdict'),               // enter | wait | avoid, from the day's final entry-signal snapshot
  strikeRef:      numeric('strike_ref'),               // ~30-delta strike this call is graded against, frozen at snapshot time
  horizonDays:    integer('horizon_days').notNull().default(14),
  maePct:         numeric('mae_pct'),                  // worst adverse excursion over the horizon
  strikeBreached: boolean('strike_breached'),
  fwdReturn1d:    numeric('fwd_return_1d'),
  fwdReturn10d:   numeric('fwd_return_10d'),
  status:       text('status').notNull().default('PENDING'), // PENDING | WIN | LOSS | NO_DATA
  fwdReturn5d:  numeric('fwd_return_5d'),
  gradedAt:     timestamp('graded_at', { withTimezone: true }),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  snapshotUnique: unique('idx_hotlist_snapshots_snapshot').on(t.snapshotDate, t.ticker, t.side),
  statusIdx:      index('idx_hotlist_snapshots_status').on(t.status, t.snapshotDate),
}))

export type HotlistSnapshot = typeof hotlistSnapshots.$inferSelect
export type InsertHotlistSnapshot = typeof hotlistSnapshots.$inferInsert

// ── regime_grades ─────────────────────────────────────────────────────────────
// Multi-horizon grading of business-cycle regime calls against forward SPY.
// Deliberately NO FK to market_regime and fully denormalized: market_regime keeps
// only the latest 90 rows, which can be pruned before the 12-week horizon matures.
// Pending stubs (all 3 horizons) are inserted at each weekly snapshot for the last
// market_regime row per UTC day; graded once classifiedAt + horizon has passed.

export const regimeGrades = pgTable('regime_grades', {
  id:                serial('id').primaryKey(),
  regimeRowId:       integer('regime_row_id').notNull(), // market_regime.id (no FK — see note)
  regime:            text('regime').notNull(),
  confidence:        integer('confidence').notNull(),
  classifiedAt:      timestamp('classified_at', { withTimezone: true }).notNull(),
  horizon:           text('horizon').notNull(),           // 1w | 4w | 12w
  expectedDirection: text('expected_direction').notNull(),// bullish | bearish | neutral
  spyStart:          numeric('spy_start'),
  spyEnd:            numeric('spy_end'),
  fwdReturnPct:      numeric('fwd_return_pct'),
  maxDrawdownPct:    numeric('max_drawdown_pct'),
  grade:             text('grade').notNull().default('pending'), // pending | correct | partial | incorrect | no_data
  gradedAt:          timestamp('graded_at', { withTimezone: true }),
}, t => ({
  rowHorizonUnique: unique('idx_regime_grades_row_horizon').on(t.regimeRowId, t.horizon),
  classifiedIdx:    index('idx_regime_grades_classified').on(t.classifiedAt),
}))

export type RegimeGrade = typeof regimeGrades.$inferSelect
export type InsertRegimeGrade = typeof regimeGrades.$inferInsert

// ── intraday_day_stats ────────────────────────────────────────────────────────
// One row per (trading day, index symbol) capturing the shape of the session:
// where the high/low printed and how far into the day. This is what makes
// "reversals have been hitting around 10 AM PT" answerable — the Live tab's
// checkpoint history records the model's CALL, this records what actually happened.
// barsJson keeps the raw 5m series so checkpoints can be re-derived later without
// re-hitting Yahoo (which only serves 5m bars ~60 days back).

export const intradayDayStats = pgTable('intraday_day_stats', {
  id:             serial('id').primaryKey(),
  date:           date('date').notNull(),
  ticker:         text('ticker').notNull(),        // SPY | QQQ
  open:           numeric('open').notNull(),
  high:           numeric('high').notNull(),
  low:            numeric('low').notNull(),
  close:          numeric('close').notNull(),
  highAtMin:      integer('high_at_min').notNull(), // minutes after 9:30 ET
  lowAtMin:       integer('low_at_min').notNull(),
  closeVsOpenPct: numeric('close_vs_open_pct').notNull(),
  rangePct:       numeric('range_pct').notNull(),
  dayShape:       text('day_shape').notNull(),      // reversal-up | reversal-down | trend-up | trend-down | chop
  reversalAtMin:  integer('reversal_at_min'),       // null unless dayShape is a reversal
  barsJson:       jsonb('bars_json').notNull(),
  createdAt:      timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => ({
  dayUnique:  unique('idx_intraday_day_stats_day').on(t.date, t.ticker),
  shapeIdx:   index('idx_intraday_day_stats_shape').on(t.dayShape, t.date),
}))

export type IntradayDayStat = typeof intradayDayStats.$inferSelect
export type InsertIntradayDayStat = typeof intradayDayStats.$inferInsert

// ── intraday_checkpoint_grades ────────────────────────────────────────────────
// Grades each intraday regime checkpoint against what the tape did afterwards.
// The SymbolSignal inputs are flattened (rather than left in app_config JSON) so
// pattern queries like "reversal rate when a sweep-reclaim was present" are plain SQL.
// `reconstructed` marks rows replayed from stored bars for days the server never
// ran: direction/score are exact, but hotlist breadth has no historical snapshot,
// so their confidence is the pre-breadth value and must be captioned as such.

export const intradayCheckpointGrades = pgTable('intraday_checkpoint_grades', {
  id:                serial('id').primaryKey(),
  date:              date('date').notNull(),
  ticker:            text('ticker').notNull(),
  minAfterOpen:      integer('min_after_open').notNull(),
  direction:         text('direction'),              // bullish | bearish | null (no lean)
  confidence:        integer('confidence'),
  breakout:          text('breakout').notNull(),
  vwapSepPct:        numeric('vwap_sep_pct').notNull(),
  pullbackPct:       numeric('pullback_pct').notNull(),
  priorDaySweep:     text('prior_day_sweep'),        // bullish-reclaim | bearish-reclaim | null
  priceAtCheckpoint: numeric('price_at_checkpoint').notNull(),
  fwd30mPct:         numeric('fwd_30m_pct'),
  fwd60mPct:         numeric('fwd_60m_pct'),
  fwdClosePct:       numeric('fwd_close_pct'),
  grade:             text('grade').notNull().default('pending'), // correct | incorrect | flat | no_data | pending
  reconstructed:     boolean('reconstructed').notNull().default(false),
  gradedAt:          timestamp('graded_at', { withTimezone: true }),
}, t => ({
  checkpointUnique: unique('idx_intraday_cp_grades_checkpoint').on(t.date, t.ticker, t.minAfterOpen),
  bucketIdx:        index('idx_intraday_cp_grades_bucket').on(t.minAfterOpen, t.direction, t.grade),
}))

export type IntradayCheckpointGrade = typeof intradayCheckpointGrades.$inferSelect
export type InsertIntradayCheckpointGrade = typeof intradayCheckpointGrades.$inferInsert
