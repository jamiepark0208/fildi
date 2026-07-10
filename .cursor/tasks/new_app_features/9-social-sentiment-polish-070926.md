# social-sentiment-polish

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | ui (+ optional light API — **gated**) |
| **Effort** | M (trending widget); L if watchlist chips + server route |
| **Created** | 2026-07-09 |
| **Source** | competitive-research |
| **Research** | [competitive-ux-research](1-competitive-ux-research-070926.md) |
| **Related** | [feed-improvements](../enhancements/13-feed-improvements-070926.md) (**client trending**), [analyst-leaderboard](7-analyst-leaderboard-track-record-070926.md), [macro-volatility / COT](../enhancements/17-macro-volatility-tab-improvements-070926.md) (**`/sentiment` = COT — not this**), [watchlist-monitor](../enhancements/16-watchlist-monitor-improvements-070926.md) |
| **Type** | ENHANCE (community pulse from own posts — not StockTwits) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Answer *"What is the crowd posting about?"* on Feed — trending tickers from invite-only `trade_posts`, click-through to existing ticker filter. Optional watchlist activity chips later.

### Cache / DB compliance
**v1 default: client aggregate** on loaded feed posts (align with enh/13 — **no** new route required).  
**v1.1 (only if watchlist chips need global 7d counts):** `GET /api/feed/trending-tickers` + TTLCache **10m** — DB only, no Yahoo.  
No StockTwits/Reddit. No Redis. No WebSocket. Polls deferred (no `post_votes` in v1).

---

## 1. Executive summary (rescoped)

**Name collision — read first:**
- Route `/sentiment` + `sentiment.tsx` = **COT Positioning** (`/api/cot/*`) — page title already “COT Positioning” L327
- **Not in sidebar** today (`sidebar.tsx` grep empty for sentiment)
- enh/17 folds COT into Macro Volatility and **redirects** `/sentiment` — this task must **not** rewrite that page into social UI

**Already present:**
- Feed ticker filter via search (`feed.tsx` L215–227 `params.set("ticker", …)`)
- `sort=top` = **likes on posts**, not tickers
- Likes / posts tables for aggregation
- enh/13 W4: optional **client** trending strip; explicitly **forbids** `/api/feed/trending`

**Do (v1 — prefer merge with enh/13):**
1. `TrendingTickers` widget on `/feed` — top tickers by post count (± likes) from **current loaded posts** or last-N client window
2. Chip click → set feed ticker filter (existing search/query path)
3. Copy: “Community activity (this page)” or “from loaded posts” — honest about sample
4. Document polls as **v1.5** (use likes as proxy until then)

**Do (v1.1 — only if product insists on watchlist “3 ideas this week”):**
5. Then add `GET /api/feed/trending-tickers?days=7&limit=10` — **reconcile** enh/13 out-of-scope by updating enh/13 Related note when shipping (server route justified by cross-page need)
6. Watchlist row chip from that map

**Do not:** StockTwits API; rewrite `/sentiment`; AI digest; WebSocket; conviction poll table in v1; duplicate seq 7 leaderboard.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| No ticker discovery pulse | Feed has TopPerformers (users) + post list; no ticker heatmap |
| `sort=top` ≠ trending tickers | `feed.ts` L94–96 likes per **post** |
| Ticker filter exists | `feed.tsx` L215–220 — widget should drive it |
| enh/13 conflict | Pack forbids `/api/feed/trending`; allows client strip W4 |
| `/sentiment` trap | COT page L301–327; enh/17 redirect plan |
| Competitor | StockTwits trending — **pattern only**, own data |

---

## 3. What (build scope)

### In scope — Phase A (v1)
| # | Work |
|---|---|
| W1 | `TrendingTickers` — client aggregate from `posts` in feed query |
| W2 | Mount on feed (header or beside TopPerformers) |
| W3 | Click → `setSearch` / ticker filter already used by feed |
| W4 | Empty state when &lt;2 distinct tickers |
| W5 | Cross-link / implement enh/13 W4 here if enh/13 not started — **one widget, don’t fork** |

### In scope — Phase B (v1.1, optional)
| # | Work |
|---|---|
| W6 | `GET /api/feed/trending-tickers` — 7d GROUP BY ticker |
| W7 | Watchlist activity chip “N ideas / 7d” |
| W8 | TTLCache 10m `feed-trending-tickers` |

### Out of scope
| Item | Reason |
|---|---|
| StockTwits / X / Reddit APIs | Cost, licensing, noise |
| Rewrite `sentiment.tsx` as social | Wrong page; enh/17 owns COT fold |
| Sidebar rename “Sentiment” | Item absent; enh/17 removes route |
| `post_votes` / Yes-No poll | Defer v1.5 — likes proxy |
| AI feed digest | Token cost |
| Real-time WS | Overkill |
| TipRanks social scrape | Forbidden |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| No trending API | `feed.ts` routes — posts/profile/buckets only |
| Feed ticker filter | `feed.tsx` L215–227 |
| TopPerformers = users | L114–183 |
| COT on `/sentiment` | `sentiment.tsx` L304–312 `/api/cot/summary` |
| Sidebar has no Sentiment | `DEFAULT_GROUPS` L45–74 |
| enh/13 forbids server trending | enh/13 §1 + out of scope |
| enh/17 Related points here | Name collision documented |
| Lessons | none matching sentiment/stocktwits |

### 4.2 Files to modify

| Pri | Path | Phase | Change |
|---|---|---|---|
| **P0** | `components/feed/TrendingTickers.tsx` | A | **New** |
| **P0** | `pages/feed.tsx` | A | Mount + wire filter |
| **P1** | `routes/feed.ts` | B only | `GET /feed/trending-tickers` |
| **P1** | `pages/watchlist.tsx` | B only | Activity chip |
| — | `pages/sentiment.tsx` | — | **Do not modify** (enh/17) |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| enh/13 pack | Own client trending contract — merge W4 |
| enh/17 pack | COT redirect |
| seq 7 leaderboard | Different aggregation (users, closed≥5) |

### 4.4 Client aggregate (Phase A)

```
for post in posts:
  count[ticker] += 1
  likes[ticker] += post.likeCount
rank by (count + likes) desc; take 5–10
onClick → set feed search to ticker (existing debounce path)
```

### 4.5 Server SQL (Phase B only)

```sql
SELECT ticker,
  COUNT(*)::int AS post_count,
  COALESCE(SUM((SELECT COUNT(*) FROM likes WHERE likes.post_id = trade_posts.id)), 0) AS like_count
FROM trade_posts
WHERE created_at > NOW() - ($days || ' days')::interval
GROUP BY ticker
ORDER BY post_count + like_count DESC
LIMIT $limit
```

Auth: same session as feed. Cache: TTLCache 10m.

### 4.6 Acceptance criteria

**Phase A:**
- [ ] Feed shows trending ticker chips from loaded posts
- [ ] Click filters feed to that ticker (existing API param)
- [ ] No external social APIs; no `sentiment.tsx` edits
- [ ] Does not conflict with seq 7 leaderboard UI
- [ ] stock-compare typecheck

**Phase B (if built):**
- [ ] Endpoint returns 7d aggregates; watchlist chip matches
- [ ] enh/13 Related updated to allow this route
- [ ] api-server typecheck + rebuild

### 4.7 Suggested commit messages

Phase A: `feat(feed): client trending tickers widget`  
Phase B: `feat(feed): trending-tickers API + watchlist activity chips`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **enh/13** | **Hard coordinate** — Phase A = their W4; don’t ship two strips |
| enh/17 | Soft — leave COT alone |
| seq 7 | Soft — layout space on feed (TopPerformers vs Trending) |
| enh/16 watchlist | Soft — chip placement |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- Phase A: feed UI only  
- Phase B: feed.ts + watchlist  
- Rollback: remove widget; drop route if added

### 2. Bug introductions
- Confusing `/sentiment` with social — **builder must not open COT page for this**
- Client trending ≠ global 7d — label honestly or ship Phase B
- Dual widgets if enh/13 also adds strip — **one owner**
- Catch: post NVDA twice → NVDA chip; click filters feed

### 3. Performance
- Phase A: O(posts) client  
- Phase B: one GROUP BY + 10m cache

### 4. Workflow
- Scan trending → open ticker filter → Validate in scanner (enh/13 CTA)

### 5. Drift
- Paired: TrendingTickers ↔ enh/13 W4 ↔ feed ticker param ↔ (B) watchlist chips  
- Name: “social sentiment” ≠ COT `/sentiment`

**Do not:** StockTwits; edit sentiment.tsx; polls table v1; ignore enh/13 no-route rule without Phase B justification.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE-WITH-NITS — ready after rescope  
**Lenses:** PM Rescope (client-first) | UX Keep pulse | Eng Keep (honor enh/13) | BA Phase A/B gates | User useful if labeled  
**Nits applied in this pack:** Dropped v1 server route + polls; locked COT out; merge trending with enh/13 W4.  
**Key:** Community ticker pulse on Feed from own posts; `/sentiment` stays COT (enh/17).
