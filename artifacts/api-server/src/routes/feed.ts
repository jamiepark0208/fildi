import { Router } from 'express'
import { eq, and, sql, count, sum, desc, asc, ilike, inArray } from 'drizzle-orm'
import { db, tradePosts, likes, comments, users, stockBuckets, stockHoldings, pricesHistorical } from '@workspace/db'
import { requireAuth } from '../middleware/requireAuth.js'
import { getLatestRegime } from './regime.js'
import { resolveExpiredOptionTrades } from '../lib/trade-post-expiry.js'
import { getBuyingPower, getAvailableShares, InsufficientFundsError } from '../lib/buying-power.js'
import { computeTickerPnlRollup } from '../lib/ticker-pnl.js'

const router = Router()
router.use(requireAuth)

// Paper-trading starting balance — matches users.cash_balance's DB default for new accounts.
const STARTING_CASH = 100_000

// ── helpers ────────────────────────────────────────────────────────────────────

function parseNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return isNaN(n) ? null : n
}

function numericPostFields(row: Record<string, unknown>) {
  return {
    ...row,
    strike:             parseNum(row['strike']),
    premiumPerContract: parseNum(row['premiumPerContract']),
    ivRankAtEntry:      parseNum(row['ivRankAtEntry']),
    techScoreAtEntry:   parseNum(row['techScoreAtEntry']),
    vixAtEntry:         parseNum(row['vixAtEntry']),
    closePremium:       parseNum(row['closePremium']),
    resolvedPnl:        parseNum(row['resolvedPnl']),
  }
}

function isValidFutureDate(s: string): boolean {
  const d = new Date(s)
  return !isNaN(d.getTime()) && d >= new Date()
}

// Shared base query columns for list-style queries
async function fetchPosts(opts: {
  userId: number
  ticker?: string
  username?: string
  status?: string
  sort?: string
  limit: number
  offset: number
}) {
  const { userId, ticker, username, status, sort, limit, offset } = opts

  const likeCount = db.$count(likes, eq(likes.postId, tradePosts.id))
  const commentCount = db.$count(comments, eq(comments.postId, tradePosts.id))

  // We do this with raw SQL for the likedByMe subquery
  const rows = await db
    .select({
      id:                   tradePosts.id,
      userId:               tradePosts.userId,
      ticker:               tradePosts.ticker,
      tradeType:            tradePosts.tradeType,
      strike:               tradePosts.strike,
      expiry:               tradePosts.expiry,
      contracts:            tradePosts.contracts,
      premiumPerContract:   tradePosts.premiumPerContract,
      confidence:           tradePosts.confidence,
      notes:                tradePosts.notes,
      ivRankAtEntry:        tradePosts.ivRankAtEntry,
      techScoreAtEntry:     tradePosts.techScoreAtEntry,
      regimeAtEntry:        tradePosts.regimeAtEntry,
      vixAtEntry:           tradePosts.vixAtEntry,
      signalAtEntry:        tradePosts.signalAtEntry,
      status:               tradePosts.status,
      closePremium:         tradePosts.closePremium,
      resolvedAt:           tradePosts.resolvedAt,
      resolvedPnl:          tradePosts.resolvedPnl,
      direction:            tradePosts.direction,
      entryPrice:           tradePosts.entryPrice,
      shares:               tradePosts.shares,
      stopLoss:             tradePosts.stopLoss,
      targetPrice:          tradePosts.targetPrice,
      createdAt:            tradePosts.createdAt,
      updatedAt:            tradePosts.updatedAt,
      username:             users.username,
      avatarUrl:            users.avatarUrl,
      likeCount:            sql<number>`(SELECT COUNT(*) FROM likes WHERE likes.post_id = ${tradePosts.id})`.mapWith(Number),
      commentCount:         sql<number>`(SELECT COUNT(*) FROM comments WHERE comments.post_id = ${tradePosts.id})`.mapWith(Number),
      likedByMe:            sql<boolean>`EXISTS(SELECT 1 FROM likes WHERE likes.post_id = ${tradePosts.id} AND likes.user_id = ${userId})`,
    })
    .from(tradePosts)
    .innerJoin(users, eq(users.id, tradePosts.userId))
    .where(and(
      ticker   ? ilike(tradePosts.ticker, ticker.toUpperCase()) : undefined,
      username ? eq(users.username, username) : undefined,
      status   ? eq(tradePosts.status, status.toUpperCase()) : undefined,
    ))
    .orderBy(
      sort === 'top'
        ? desc(sql`(SELECT COUNT(*) FROM likes WHERE likes.post_id = ${tradePosts.id})`)
        : desc(tradePosts.createdAt)
    )
    .limit(limit)
    .offset(offset)

  return rows.map(r => numericPostFields(r as Record<string, unknown>))
}

// ── POST /api/feed/posts ───────────────────────────────────────────────────────

const OPTION_TYPES = new Set(['SELL_PUT', 'BUY_PUT', 'SELL_CALL', 'BUY_CALL'])
const EQUITY_TYPES = new Set(['LONG', 'SHORT'])

router.post('/feed/posts', async (req, res) => {
  const userId = req.session.userId!
  const { ticker, tradeType, confidence, notes,
          // options fields
          strike, expiry, contracts, premiumPerContract,
          // equity fields
          direction, entryPrice, shares, stopLoss, targetPrice,
          // context
          ivRankAtEntry, techScoreAtEntry, regimeAtEntry, vixAtEntry, signalAtEntry } = req.body

  if (!ticker || typeof ticker !== 'string' || ticker.trim().length === 0 || ticker.trim().length > 10)
    return res.status(400).json({ error: 'ticker: non-empty string, max 10 chars' })
  if (!tradeType || (!OPTION_TYPES.has(tradeType) && !EQUITY_TYPES.has(tradeType)))
    return res.status(400).json({ error: 'tradeType: must be SELL_PUT, BUY_PUT, SELL_CALL, BUY_CALL, LONG, or SHORT' })
  if (!confidence || !Number.isInteger(Number(confidence)) || Number(confidence) < 1 || Number(confidence) > 5)
    return res.status(400).json({ error: 'confidence: integer 1–5 required' })

  const isOption = OPTION_TYPES.has(tradeType)

  if (isOption) {
    if (!strike || Number(strike) <= 0)
      return res.status(400).json({ error: 'strike: positive number required' })
    if (!expiry || !isValidFutureDate(expiry))
      return res.status(400).json({ error: 'expiry: valid future date required' })
    if (!contracts || !Number.isInteger(Number(contracts)) || Number(contracts) < 1)
      return res.status(400).json({ error: 'contracts: integer >= 1 required' })
    if (!premiumPerContract || Number(premiumPerContract) <= 0)
      return res.status(400).json({ error: 'premiumPerContract: positive number required' })
  } else {
    if (!entryPrice || Number(entryPrice) <= 0)
      return res.status(400).json({ error: 'entryPrice: positive number required' })
    if (!shares || !Number.isInteger(Number(shares)) || Number(shares) < 1)
      return res.status(400).json({ error: 'shares: integer >= 1 required' })
  }

  const normalizedTicker = ticker.trim().toUpperCase()
  const regimeAtEntryResolved = regimeAtEntry ?? (await getLatestRegime())

  try {
    const created = await db.transaction(async tx => {
      // Lock the user row so concurrent posts can't both pass a buying-power
      // check before either commits (classic TOCTOU on the derived buying-power read).
      const [userRow] = await tx.select().from(users).where(eq(users.id, userId)).for('update')
      if (!userRow) throw new InsufficientFundsError('user not found')

      let cashDelta = 0

      if (tradeType === 'SELL_PUT') {
        const collateral = Number(strike) * 100 * Number(contracts)
        if ((await getBuyingPower(userId, tx)) - collateral < 0)
          throw new InsufficientFundsError('insufficient buying power for cash-secured put')
        cashDelta = Number(premiumPerContract) * 100 * Number(contracts)
      } else if (tradeType === 'SELL_CALL') {
        const needed = Number(contracts) * 100
        if ((await getAvailableShares(userId, normalizedTicker, tx)) < needed)
          throw new InsufficientFundsError('insufficient shares to cover this call')
        cashDelta = Number(premiumPerContract) * 100 * Number(contracts)
      } else if (tradeType === 'BUY_PUT' || tradeType === 'BUY_CALL') {
        const cost = Number(premiumPerContract) * 100 * Number(contracts)
        if ((await getBuyingPower(userId, tx)) < cost)
          throw new InsufficientFundsError('insufficient buying power')
        cashDelta = -cost
      } else if (tradeType === 'LONG') {
        const cost = Number(entryPrice) * Number(shares)
        if ((await getBuyingPower(userId, tx)) < cost)
          throw new InsufficientFundsError('insufficient buying power')
        cashDelta = -cost
      } else if (tradeType === 'SHORT') {
        const notional = Number(entryPrice) * Number(shares)
        if ((await getBuyingPower(userId, tx)) < notional)
          throw new InsufficientFundsError('insufficient buying power to short (requires 100% cash collateral)')
        cashDelta = notional
      }

      if (cashDelta !== 0) {
        await tx.update(users)
          .set({ cashBalance: sql`${users.cashBalance} + ${cashDelta}` })
          .where(eq(users.id, userId))
      }

      const [post] = await tx.insert(tradePosts).values({
        userId,
        ticker:             normalizedTicker,
        tradeType,
        // options (nullable for equity)
        strike:             isOption ? String(strike) : '0',
        expiry:             isOption ? expiry : new Date().toISOString().split('T')[0],
        contracts:          isOption ? Number(contracts) : 0,
        premiumPerContract: isOption ? String(premiumPerContract) : '0',
        // equity
        direction:          !isOption ? tradeType.toLowerCase() : null,
        entryPrice:         !isOption && entryPrice != null ? String(entryPrice) : null,
        shares:             !isOption && shares != null ? Number(shares) : null,
        stopLoss:           stopLoss != null ? String(stopLoss) : null,
        targetPrice:        targetPrice != null ? String(targetPrice) : null,
        confidence:         Number(confidence),
        notes:              notes ?? null,
        ivRankAtEntry:      ivRankAtEntry != null ? String(ivRankAtEntry) : null,
        techScoreAtEntry:   techScoreAtEntry != null ? String(techScoreAtEntry) : null,
        regimeAtEntry:      regimeAtEntryResolved,
        vixAtEntry:         vixAtEntry != null ? String(vixAtEntry) : null,
        signalAtEntry:      signalAtEntry ?? null,
      }).returning()

      // LONG/SHORT open a stock_holdings position immediately (unlike options, which
      // only create one on assignment) — this is what makes "shares owned" derivable
      // for a later covered call, and gives the position a lifecycle to close later.
      if (tradeType === 'LONG' || tradeType === 'SHORT') {
        await tx.insert(stockHoldings).values({
          userId,
          ticker:           normalizedTicker,
          shares:           tradeType === 'LONG' ? Number(shares) : -Number(shares),
          costBasis:        String(entryPrice),
          source:           tradeType === 'LONG' ? 'LONG_TRADE' : 'SHORT_TRADE',
          status:           'OPEN',
          openedFromPostId: post.id,
        })
      }

      return post
    })

    return res.status(201).json(numericPostFields(created as Record<string, unknown>))
  } catch (err) {
    if (err instanceof InsufficientFundsError)
      return res.status(400).json({ error: err.message })
    throw err
  }
})

// ── GET /api/feed/posts ────────────────────────────────────────────────────────

router.get('/feed/posts', async (req, res) => {
  const userId  = req.session.userId!
  const { ticker, username, status, sort } = req.query as Record<string, string | undefined>
  const limit  = Math.min(Number(req.query['limit']  ?? 50), 100)
  const offset = Number(req.query['offset'] ?? 0)

  await resolveExpiredOptionTrades().catch(err => console.error('resolveExpiredOptionTrades failed', err))

  const posts = await fetchPosts({ userId, ticker, username, status, sort, limit, offset })
  return res.json(posts)
})

// ── GET /api/feed/posts/:id ────────────────────────────────────────────────────

router.get('/feed/posts/:id', async (req, res) => {
  const userId = req.session.userId!
  const postId = Number(req.params['id'])

  await resolveExpiredOptionTrades().catch(err => console.error('resolveExpiredOptionTrades failed', err))

  const rows = await db
    .select({
      id:                   tradePosts.id,
      userId:               tradePosts.userId,
      ticker:               tradePosts.ticker,
      tradeType:            tradePosts.tradeType,
      strike:               tradePosts.strike,
      expiry:               tradePosts.expiry,
      contracts:            tradePosts.contracts,
      premiumPerContract:   tradePosts.premiumPerContract,
      confidence:           tradePosts.confidence,
      notes:                tradePosts.notes,
      ivRankAtEntry:        tradePosts.ivRankAtEntry,
      techScoreAtEntry:     tradePosts.techScoreAtEntry,
      regimeAtEntry:        tradePosts.regimeAtEntry,
      vixAtEntry:           tradePosts.vixAtEntry,
      signalAtEntry:        tradePosts.signalAtEntry,
      status:               tradePosts.status,
      closePremium:         tradePosts.closePremium,
      resolvedAt:           tradePosts.resolvedAt,
      resolvedPnl:          tradePosts.resolvedPnl,
      direction:            tradePosts.direction,
      entryPrice:           tradePosts.entryPrice,
      shares:               tradePosts.shares,
      stopLoss:             tradePosts.stopLoss,
      targetPrice:          tradePosts.targetPrice,
      createdAt:            tradePosts.createdAt,
      updatedAt:            tradePosts.updatedAt,
      username:             users.username,
      avatarUrl:            users.avatarUrl,
      likeCount:    sql<number>`(SELECT COUNT(*) FROM likes WHERE likes.post_id = ${tradePosts.id})`.mapWith(Number),
      commentCount: sql<number>`(SELECT COUNT(*) FROM comments WHERE comments.post_id = ${tradePosts.id})`.mapWith(Number),
      likedByMe:    sql<boolean>`EXISTS(SELECT 1 FROM likes WHERE likes.post_id = ${tradePosts.id} AND likes.user_id = ${userId})`,
    })
    .from(tradePosts)
    .innerJoin(users, eq(users.id, tradePosts.userId))
    .where(eq(tradePosts.id, postId))

  if (!rows.length) return res.status(404).json({ error: 'Post not found' })

  const postComments = await db
    .select({
      id:        comments.id,
      body:      comments.body,
      createdAt: comments.createdAt,
      userId:    comments.userId,
      username:  users.username,
      avatarUrl: users.avatarUrl,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.userId))
    .where(eq(comments.postId, postId))
    .orderBy(asc(comments.createdAt))

  return res.json({
    ...numericPostFields(rows[0]! as Record<string, unknown>),
    comments: postComments,
  })
})

// ── PATCH /api/feed/posts/:id/close ───────────────────────────────────────────

router.patch('/feed/posts/:id/close', async (req, res) => {
  const userId = req.session.userId!
  const postId = Number(req.params['id'])
  const { closePremium } = req.body

  const [post] = await db.select().from(tradePosts).where(eq(tradePosts.id, postId))
  if (!post) return res.status(404).json({ error: 'Post not found' })
  if (post.userId !== userId) return res.status(403).json({ error: 'Forbidden' })
  if (post.status !== 'OPEN') return res.status(400).json({ error: 'Post is not OPEN' })

  if (closePremium == null || Number(closePremium) < 0)
    return res.status(400).json({ error: 'closePremium: non-negative number required' })

  const resolvedPnl = (Number(post.premiumPerContract) - Number(closePremium)) * post.contracts * 100

  const [updated] = await db
    .update(tradePosts)
    .set({
      status:       'CLOSED',
      closePremium: String(closePremium),
      resolvedAt:   new Date(),
      resolvedPnl:  String(resolvedPnl),
      updatedAt:    new Date(),
    })
    .where(eq(tradePosts.id, postId))
    .returning()

  return res.json(numericPostFields(updated as Record<string, unknown>))
})

// ── DELETE /api/feed/posts/:id ─────────────────────────────────────────────────

router.delete('/feed/posts/:id', async (req, res) => {
  const userId = req.session.userId!
  const role   = req.session.role!
  const postId = Number(req.params['id'])

  const [post] = await db.select().from(tradePosts).where(eq(tradePosts.id, postId))
  if (!post) return res.status(404).json({ error: 'Post not found' })
  if (post.userId !== userId && role !== 'admin') return res.status(403).json({ error: 'Forbidden' })
  if (post.status !== 'OPEN') return res.status(400).json({ error: 'Can only delete OPEN posts' })

  await db.delete(tradePosts).where(eq(tradePosts.id, postId))
  return res.json({ ok: true })
})

// ── POST /api/feed/posts/:id/like ─────────────────────────────────────────────

router.post('/feed/posts/:id/like', async (req, res) => {
  const userId = req.session.userId!
  const postId = Number(req.params['id'])

  const [post] = await db.select({ id: tradePosts.id }).from(tradePosts).where(eq(tradePosts.id, postId))
  if (!post) return res.status(404).json({ error: 'Post not found' })

  await db.insert(likes).values({ postId, userId }).onConflictDoNothing()

  const [{ likeCount }] = await db
    .select({ likeCount: count() })
    .from(likes)
    .where(eq(likes.postId, postId))

  return res.json({ likeCount, likedByMe: true })
})

// ── DELETE /api/feed/posts/:id/like ───────────────────────────────────────────

router.delete('/feed/posts/:id/like', async (req, res) => {
  const userId = req.session.userId!
  const postId = Number(req.params['id'])

  await db.delete(likes).where(and(eq(likes.postId, postId), eq(likes.userId, userId)))

  const [{ likeCount }] = await db
    .select({ likeCount: count() })
    .from(likes)
    .where(eq(likes.postId, postId))

  return res.json({ likeCount, likedByMe: false })
})

// ── POST /api/feed/posts/:id/comments ─────────────────────────────────────────

router.post('/feed/posts/:id/comments', async (req, res) => {
  const userId = req.session.userId!
  const postId = Number(req.params['id'])
  const { body } = req.body

  if (!body || typeof body !== 'string' || body.trim().length === 0)
    return res.status(400).json({ error: 'body: non-empty string required' })
  if (body.trim().length > 500)
    return res.status(400).json({ error: 'body: max 500 chars' })

  const [post] = await db.select({ id: tradePosts.id }).from(tradePosts).where(eq(tradePosts.id, postId))
  if (!post) return res.status(404).json({ error: 'Post not found' })

  const [created] = await db.insert(comments).values({ postId, userId, body: body.trim() }).returning()

  const [user] = await db
    .select({ username: users.username, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, userId))

  return res.status(201).json({
    id:        created!.id,
    postId:    created!.postId,
    userId:    created!.userId,
    username:  user!.username,
    avatarUrl: user!.avatarUrl,
    body:      created!.body,
    createdAt: created!.createdAt,
  })
})

// ── DELETE /api/feed/comments/:id ─────────────────────────────────────────────

router.delete('/feed/comments/:id', async (req, res) => {
  const userId    = req.session.userId!
  const role      = req.session.role!
  const commentId = Number(req.params['id'])

  const [comment] = await db.select().from(comments).where(eq(comments.id, commentId))
  if (!comment) return res.status(404).json({ error: 'Comment not found' })
  if (comment.userId !== userId && role !== 'admin') return res.status(403).json({ error: 'Forbidden' })

  await db.delete(comments).where(eq(comments.id, commentId))
  return res.json({ ok: true })
})

// ── GET /api/feed/profile/:username ───────────────────────────────────────────

router.get('/feed/users', async (_req, res) => {
  const rows = await db
    .select({ username: users.username, avatarUrl: users.avatarUrl })
    .from(users)
    .orderBy(asc(users.username))
  return res.json(rows)
})

router.get('/feed/profile/:username', async (req, res) => {
  const viewerId = req.session.userId!
  const { username } = req.params

  const [user] = await db
    .select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl, role: users.role, createdAt: users.createdAt, cashBalance: users.cashBalance })
    .from(users)
    .where(eq(users.username, username!))

  if (!user) return res.status(404).json({ error: 'User not found' })

  // resolved = CLOSED (manual close) + EXPIRED_WIN/EXPIRED_LOSS (auto-expired) — must match
  // the client's TopPerformers aggregation in feed.tsx, which counts both paths as resolved.
  const [stats] = await db
    .select({
      totalPosts: count(),
      openPosts:  sql<number>`SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END)`.mapWith(Number),
      wins:       sql<number>`SUM(CASE WHEN (status = 'CLOSED' AND resolved_pnl > 0) OR status = 'EXPIRED_WIN' OR status = 'ASSIGNED' THEN 1 ELSE 0 END)`.mapWith(Number),
      losses:     sql<number>`SUM(CASE WHEN (status = 'CLOSED' AND resolved_pnl <= 0) OR status = 'EXPIRED_LOSS' THEN 1 ELSE 0 END)`.mapWith(Number),
      closed:     sql<number>`SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END)`.mapWith(Number),
      totalPnl:   sum(tradePosts.resolvedPnl),
    })
    .from(tradePosts)
    .where(eq(tradePosts.userId, user.id))

  const s = stats!
  const resolved = (s.wins ?? 0) + (s.losses ?? 0)
  const winRate  = resolved > 0 ? (s.wins ?? 0) / resolved : null
  const totalPnl = s.totalPnl != null ? parseNum(s.totalPnl) : null

  const userPosts = await fetchPosts({
    userId:   viewerId,
    username: user.username,
    limit:    50,
    offset:   0,
  })

  // Stock holdings — shares from assigned puts + direct LONG/SHORT trades (see
  // trade-post-expiry.ts and POST /feed/posts). Marked to the latest daily close,
  // not a live quote (see caching-patterns.md; this reuses data already fetched
  // for option settlement, no new API cost).
  const holdingRows = await db
    .select()
    .from(stockHoldings)
    .where(eq(stockHoldings.userId, user.id))
    .orderBy(desc(stockHoldings.openedAt))

  // Previously this ran 3 queries PER ticker (latest close + the 2 inside
  // getAvailableShares) — 60 round-trips for a 20-ticker portfolio. Collapsed to 3
  // set-based queries total; getAvailableShares stays for the single-holding paths.
  const openTickers = [...new Set(holdingRows.filter(h => h.status === 'OPEN').map(h => h.ticker))]
  const latestCloseByTicker = new Map<string, number>()
  const availableForCallByTicker = new Map<string, number>()

  if (openTickers.length > 0) {
    const [priceResult, ownedRows, committedRows] = await Promise.all([
      db.execute(sql`
        SELECT DISTINCT ON (ticker) ticker, close
        FROM ${pricesHistorical}
        WHERE ticker IN (${sql.join(openTickers.map(t => sql`${t}`), sql`, `)})
        ORDER BY ticker, date DESC
      `),
      db.select({ ticker: stockHoldings.ticker, total: sql<string | null>`SUM(${stockHoldings.shares})` })
        .from(stockHoldings)
        .where(and(
          eq(stockHoldings.userId, user.id),
          eq(stockHoldings.status, 'OPEN'),
          sql`${stockHoldings.shares} > 0`,
          inArray(stockHoldings.ticker, openTickers),
        ))
        .groupBy(stockHoldings.ticker),
      db.select({ ticker: tradePosts.ticker, total: sql<string | null>`SUM(${tradePosts.contracts} * 100)` })
        .from(tradePosts)
        .where(and(
          eq(tradePosts.userId, user.id),
          eq(tradePosts.tradeType, 'SELL_CALL'),
          eq(tradePosts.status, 'OPEN'),
          inArray(tradePosts.ticker, openTickers),
        ))
        .groupBy(tradePosts.ticker),
    ])

    // db.execute (node-pg) returns QueryResult { rows }, not a bare array
    const priceRows = (priceResult as unknown as { rows?: Array<{ ticker: string; close: string | null }> }).rows
      ?? (Array.isArray(priceResult) ? priceResult as unknown as Array<{ ticker: string; close: string | null }> : [])
    for (const r of priceRows) {
      if (r.close != null) latestCloseByTicker.set(r.ticker, Number(r.close))
    }
    const ownedByTicker = new Map(ownedRows.map(r => [r.ticker, Number(r.total ?? 0)]))
    const committedByTicker = new Map(committedRows.map(r => [r.ticker, Number(r.total ?? 0)]))
    for (const ticker of openTickers) {
      availableForCallByTicker.set(ticker, (ownedByTicker.get(ticker) ?? 0) - (committedByTicker.get(ticker) ?? 0))
    }
  }

  const holdings = holdingRows.map(h => {
    const currentPrice = h.status === 'OPEN' ? (latestCloseByTicker.get(h.ticker) ?? null) : null
    const unrealizedPnl = currentPrice != null ? (currentPrice - Number(h.costBasis)) * h.shares : null
    return {
      id:               h.id,
      ticker:           h.ticker,
      shares:           h.shares,
      costBasis:        Number(h.costBasis),
      source:           h.source,
      status:           h.status,
      notes:            h.notes,
      openedAt:         h.openedAt,
      closedAt:         h.closedAt,
      realizedPnl:      h.realizedPnl != null ? Number(h.realizedPnl) : null,
      currentPrice,
      unrealizedPnl,
      availableForCall: h.status === 'OPEN' && h.shares > 0 ? (availableForCallByTicker.get(h.ticker) ?? 0) : 0,
    }
  })

  const unrealizedPnl = holdings
    .filter(h => h.status === 'OPEN' && h.unrealizedPnl != null)
    .reduce((sum, h) => sum + h.unrealizedPnl!, 0)

  const tickerPnl = computeTickerPnlRollup(userPosts as unknown as { ticker: string; status: string; resolvedPnl: number | null }[], holdings)
  const buyingPower = await getBuyingPower(user.id)

  return res.json({
    user,
    account: { cashBalance: Number(user.cashBalance), buyingPower },
    stats: {
      totalPosts: s.totalPosts,
      openPosts:  s.openPosts  ?? 0,
      wins:       s.wins       ?? 0,
      losses:     s.losses     ?? 0,
      closed:     s.closed     ?? 0,
      winRate,
      totalPnl,
      unrealizedPnl,
    },
    posts:     userPosts,
    holdings,
    tickerPnl,
  })
})

// ── POST /api/feed/holdings/:id/close ──────────────────────────────────────────
// Manually closes a LONG/SHORT (or, edge case, a PUT_ASSIGNMENT) stock_holdings
// position at the latest daily close — no price entry, single click. Realized P&L
// and the cash settlement are both derived from that close price.

router.post('/feed/holdings/:id/close', async (req, res) => {
  const userId = req.session.userId!
  const holdingId = Number(req.params['id'])
  if (!Number.isInteger(holdingId)) return res.status(400).json({ error: 'invalid holding id' })

  const [holding] = await db.select().from(stockHoldings).where(eq(stockHoldings.id, holdingId))
  if (!holding || holding.userId !== userId) return res.status(404).json({ error: 'holding not found' })
  if (holding.status !== 'OPEN') return res.status(400).json({ error: 'holding is not open' })

  // A long lot currently backing an OPEN covered call can't be closed out from under it —
  // mirrors the availableShares check used when the call was created.
  if (holding.shares > 0) {
    const available = await getAvailableShares(userId, holding.ticker)
    if (available < holding.shares)
      return res.status(400).json({ error: 'cannot close shares backing an open covered call' })
  }

  const [priceRow] = await db
    .select({ close: pricesHistorical.close })
    .from(pricesHistorical)
    .where(eq(pricesHistorical.ticker, holding.ticker))
    .orderBy(desc(pricesHistorical.date))
    .limit(1)
  if (priceRow?.close == null) return res.status(400).json({ error: 'no recent price available to close at' })

  const closePrice = Number(priceRow.close)
  const realizedPnl = (closePrice - Number(holding.costBasis)) * holding.shares
  const cashDelta = closePrice * holding.shares

  const [updated] = await db.transaction(async tx => {
    await tx.update(users)
      .set({ cashBalance: sql`${users.cashBalance} + ${cashDelta}` })
      .where(eq(users.id, userId))

    return tx.update(stockHoldings).set({
      status:      'CLOSED',
      closedAt:    new Date(),
      realizedPnl: String(realizedPnl),
    }).where(eq(stockHoldings.id, holdingId)).returning()
  })

  return res.json({ ...updated, costBasis: Number(updated!.costBasis), realizedPnl: Number(updated!.realizedPnl) })
})

// ── POST /api/feed/portfolio/reset ──────────────────────────────────────────────
// Resets a user's paper-trading account: every OPEN stock_holdings position is
// closed out at the latest daily close (same math as /holdings/:id/close, applied
// in bulk) so its true realized P&L is recorded, then cash_balance is reset to the
// starting balance — plus any net gain from that closeout, so a profitable reset
// carries the win forward instead of erasing it. A net loss is absorbed (cash still
// lands on the flat starting balance) rather than digging the account into a hole.
// trade_posts (trade ideas, win rate, streak, resolved P&L) are never touched —
// those are the user's track record and outlive any number of resets.
// All-or-nothing: if ANY open holding can't be cleanly closed, nothing changes and the
// blockers come back as 409. A partial reset leaves the account incoherent — cash lands
// on the flat starting balance while un-closed lots stay OPEN, so the user keeps the
// position AND gets its money back. Two blockers exist:
//   - no recent close price (can't mark to market without guessing)
//   - the lot backs an OPEN SELL_CALL (trade_posts are never touched here, so closing
//     the lot out from under the call would leave it naked — the same invariant
//     POST /feed/holdings/:id/close enforces via getAvailableShares)
router.post('/feed/portfolio/reset', async (req, res) => {
  const userId = req.session.userId!

  const openHoldings = await db.select().from(stockHoldings)
    .where(and(eq(stockHoldings.userId, userId), eq(stockHoldings.status, 'OPEN')))

  if (openHoldings.length === 0) {
    await db.update(users).set({ cashBalance: String(STARTING_CASH) }).where(eq(users.id, userId))
    return res.json({ closedHoldings: 0, realizedPnl: 0, cashBalance: STARTING_CASH })
  }

  const tickers = [...new Set(openHoldings.map(h => h.ticker))]

  // Latest close per ticker in ONE query (DISTINCT ON) rather than one round-trip each.
  const priceResult = await db.execute(sql`
    SELECT DISTINCT ON (ticker) ticker, close
    FROM ${pricesHistorical}
    WHERE ticker IN (${sql.join(tickers.map(t => sql`${t}`), sql`, `)})
    ORDER BY ticker, date DESC
  `)
  const priceRows = (priceResult as unknown as { rows?: Array<{ ticker: string; close: string | null }> }).rows
    ?? (Array.isArray(priceResult) ? priceResult as unknown as Array<{ ticker: string; close: string | null }> : [])
  const closeByTicker = new Map<string, number>()
  for (const r of priceRows) {
    if (r.close != null) closeByTicker.set(r.ticker, Number(r.close))
  }

  const blockedNoPrice = tickers.filter(t => !closeByTicker.has(t))

  // Shares committed to OPEN SELL_CALLs, per ticker — one grouped query.
  const committedRows = await db
    .select({ ticker: tradePosts.ticker, contracts: sql<string | null>`SUM(${tradePosts.contracts} * 100)` })
    .from(tradePosts)
    .where(and(
      eq(tradePosts.userId, userId),
      eq(tradePosts.tradeType, 'SELL_CALL'),
      eq(tradePosts.status, 'OPEN'),
      inArray(tradePosts.ticker, tickers),
    ))
    .groupBy(tradePosts.ticker)
  const blockedByCall = committedRows.filter(r => Number(r.contracts ?? 0) > 0).map(r => r.ticker)

  if (blockedNoPrice.length > 0 || blockedByCall.length > 0) {
    return res.status(409).json({
      error: 'cannot reset while some positions cannot be closed',
      blockedNoPrice,
      blockedByOpenCoveredCall: blockedByCall,
    })
  }

  const closes = openHoldings.map(h => ({
    id: h.id,
    realizedPnl: (closeByTicker.get(h.ticker)! - Number(h.costBasis)) * h.shares,
  }))

  const totalRealizedPnl = closes.reduce((sum, c) => sum + c.realizedPnl, 0)
  // A profitable reset carries the win forward; a net loss is absorbed rather than
  // digging the account into a hole. NOTE: this asymmetry is a one-way ratchet —
  // see the review notes on making resets rate-limited or fully symmetric.
  const newCashBalance = STARTING_CASH + Math.max(totalRealizedPnl, 0)

  await db.transaction(async tx => {
    // Single UPDATE with a CASE rather than one round-trip per holding.
    await tx.update(stockHoldings).set({
      status:      'CLOSED',
      closedAt:    new Date(),
      realizedPnl: sql`CASE ${sql.join(
        closes.map(c => sql`WHEN ${stockHoldings.id} = ${c.id} THEN ${String(c.realizedPnl)}::numeric`),
        sql` `,
      )} END`,
    }).where(inArray(stockHoldings.id, closes.map(c => c.id)))

    await tx.update(users).set({ cashBalance: String(newCashBalance) }).where(eq(users.id, userId))
  })

  return res.json({ closedHoldings: closes.length, realizedPnl: totalRealizedPnl, cashBalance: newCashBalance })
})

// ── POST /api/feed/portfolio/reset-stats ─────────────────────────────────────
// Clean-slate track record: delete all trade_posts (win rate / streak / idea P&L).
// Keep OPEN stock_holdings but mark cost basis to latest close so unrealized ≈ 0.
// Delete CLOSED/CALLED_AWAY lots (their $0 realized rows still cluttered Top Tickers).
// Cash + buying power → 0 (no reserved collateral once posts are gone).
router.post('/feed/portfolio/reset-stats', async (req, res) => {
  const userId = req.session.userId!

  const deleted = await db.delete(tradePosts).where(eq(tradePosts.userId, userId)).returning({ id: tradePosts.id })

  const openHoldings = await db.select().from(stockHoldings)
    .where(and(eq(stockHoldings.userId, userId), eq(stockHoldings.status, 'OPEN')))

  let rebated = 0
  if (openHoldings.length > 0) {
    const tickers = [...new Set(openHoldings.map(h => h.ticker))]
    const priceResult = await db.execute(sql`
      SELECT DISTINCT ON (ticker) ticker, close
      FROM ${pricesHistorical}
      WHERE ticker IN (${sql.join(tickers.map(t => sql`${t}`), sql`, `)})
      ORDER BY ticker, date DESC
    `)
    const priceRows = (priceResult as unknown as { rows?: Array<{ ticker: string; close: string | null }> }).rows
      ?? (Array.isArray(priceResult) ? priceResult as unknown as Array<{ ticker: string; close: string | null }> : [])
    const closeByTicker = new Map<string, number>()
    for (const r of priceRows) {
      if (r.close != null) closeByTicker.set(r.ticker, Number(r.close))
    }
    for (const h of openHoldings) {
      const px = closeByTicker.get(h.ticker)
      if (px == null || !(px > 0)) continue
      await db.update(stockHoldings)
        .set({ costBasis: String(px), realizedPnl: null })
        .where(eq(stockHoldings.id, h.id))
      rebated++
    }
  }

  const removedLots = await db.delete(stockHoldings)
    .where(and(
      eq(stockHoldings.userId, userId),
      inArray(stockHoldings.status, ['CLOSED', 'CALLED_AWAY']),
    ))
    .returning({ id: stockHoldings.id })

  await db.update(users).set({ cashBalance: '0' }).where(eq(users.id, userId))

  return res.json({
    deletedPosts: deleted.length,
    holdingsMarkedToMarket: rebated,
    closedLotsRemoved: removedLots.length,
    cashBalance: 0,
  })
})

// ── GET /api/feed/buckets — all users' picks (public within the app) ──────────

router.get('/feed/buckets', async (req, res) => {
  const rows = await db
    .select({
      userId:   stockBuckets.userId,
      username: users.username,
      ticker:   stockBuckets.ticker,
      bucket:   stockBuckets.bucket,
      addedAt:  stockBuckets.addedAt,
    })
    .from(stockBuckets)
    .innerJoin(users, eq(users.id, stockBuckets.userId))
    .orderBy(asc(stockBuckets.bucket), asc(stockBuckets.ticker))

  return res.json(rows)
})

// ── GET /api/feed/buckets/:username — a specific user's picks ─────────────────

router.get('/feed/buckets/:username', async (req, res) => {
  const [profile] = await db.select({ id: users.id }).from(users).where(eq(users.username, req.params['username']!)).limit(1)
  if (!profile) return res.status(404).json({ error: 'User not found' })
  const rows = await db
    .select({ ticker: stockBuckets.ticker, bucket: stockBuckets.bucket, addedAt: stockBuckets.addedAt })
    .from(stockBuckets)
    .where(eq(stockBuckets.userId, profile.id))
    .orderBy(asc(stockBuckets.bucket), asc(stockBuckets.ticker))
  return res.json(rows)
})

// ── GET /api/feed/buckets/mine — current user's picks ─────────────────────────

router.get('/feed/buckets/mine', async (req, res) => {
  const userId = req.session.userId!
  const rows = await db
    .select({ ticker: stockBuckets.ticker, bucket: stockBuckets.bucket, addedAt: stockBuckets.addedAt })
    .from(stockBuckets)
    .where(eq(stockBuckets.userId, userId))
    .orderBy(asc(stockBuckets.bucket), asc(stockBuckets.ticker))

  return res.json(rows)
})

// ── PUT /api/feed/buckets — upsert (add or move ticker between buckets) ───────

router.put('/feed/buckets', async (req, res) => {
  const userId = req.session.userId!
  const { ticker, bucket } = req.body

  const t = typeof ticker === 'string' ? ticker.trim().toUpperCase() : ''
  if (!t || t.length > 10)
    return res.status(400).json({ error: 'ticker: non-empty string, max 10 chars' })
  if (!['BULLISH', 'NEUTRAL', 'BEARISH'].includes(bucket))
    return res.status(400).json({ error: 'bucket: must be BULLISH | NEUTRAL | BEARISH' })

  const [row] = await db
    .insert(stockBuckets)
    .values({ userId, ticker: t, bucket })
    .onConflictDoUpdate({
      target: [stockBuckets.userId, stockBuckets.ticker],
      set: { bucket, addedAt: new Date() },
    })
    .returning()

  return res.status(201).json(row)
})

// ── DELETE /api/feed/buckets/:ticker ──────────────────────────────────────────

router.delete('/feed/buckets/:ticker', async (req, res) => {
  const userId = req.session.userId!
  const ticker = req.params['ticker']!.toUpperCase()

  await db.delete(stockBuckets).where(
    and(eq(stockBuckets.userId, userId), eq(stockBuckets.ticker, ticker))
  )
  return res.json({ ok: true })
})

export default router
