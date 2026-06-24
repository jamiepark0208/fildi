import { Router } from 'express'
import { eq, and, sql, count, sum, desc, asc, ilike } from 'drizzle-orm'
import { db, tradePosts, likes, comments, users, stockBuckets } from '@workspace/db'
import { requireAuth } from '../middleware/requireAuth.js'

const router = Router()
router.use(requireAuth)

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

  const [{ openCount }] = await db
    .select({ openCount: count() })
    .from(tradePosts)
    .where(and(eq(tradePosts.userId, userId), eq(tradePosts.status, 'OPEN')))
  if (openCount >= 3)
    return res.status(429).json({ error: 'Max 3 open trade ideas at a time' })

  const [created] = await db.insert(tradePosts).values({
    userId,
    ticker:             ticker.trim().toUpperCase(),
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
    regimeAtEntry:      regimeAtEntry ?? null,
    vixAtEntry:         vixAtEntry != null ? String(vixAtEntry) : null,
    signalAtEntry:      signalAtEntry ?? null,
  }).returning()

  return res.status(201).json(numericPostFields(created as Record<string, unknown>))
})

// ── GET /api/feed/posts ────────────────────────────────────────────────────────

router.get('/feed/posts', async (req, res) => {
  const userId  = req.session.userId!
  const { ticker, username, status, sort } = req.query as Record<string, string | undefined>
  const limit  = Math.min(Number(req.query['limit']  ?? 50), 100)
  const offset = Number(req.query['offset'] ?? 0)

  const posts = await fetchPosts({ userId, ticker, username, status, sort, limit, offset })
  return res.json(posts)
})

// ── GET /api/feed/posts/:id ────────────────────────────────────────────────────

router.get('/feed/posts/:id', async (req, res) => {
  const userId = req.session.userId!
  const postId = Number(req.params['id'])

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
    .select({ id: users.id, username: users.username, avatarUrl: users.avatarUrl, role: users.role, createdAt: users.createdAt })
    .from(users)
    .where(eq(users.username, username!))

  if (!user) return res.status(404).json({ error: 'User not found' })

  const [stats] = await db
    .select({
      totalPosts: count(),
      openPosts:  sql<number>`SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END)`.mapWith(Number),
      wins:       sql<number>`SUM(CASE WHEN status = 'CLOSED' AND resolved_pnl > 0 THEN 1 ELSE 0 END)`.mapWith(Number),
      losses:     sql<number>`SUM(CASE WHEN status = 'CLOSED' AND resolved_pnl <= 0 THEN 1 ELSE 0 END)`.mapWith(Number),
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

  return res.json({
    user,
    stats: {
      totalPosts: s.totalPosts,
      openPosts:  s.openPosts  ?? 0,
      wins:       s.wins       ?? 0,
      losses:     s.losses     ?? 0,
      closed:     s.closed     ?? 0,
      winRate,
      totalPnl,
    },
    posts: userPosts,
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
