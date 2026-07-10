# analyst-leaderboard-track-record

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui + api |
| **Effort** | L |
| **Created** | 2026-07-09 |
| **Source** | competitive-research |
| **Related** | [feed-improvements](../enhancements/13-feed-improvements-070926.md), [profile-track-record](../enhancements/14-profile-track-record-improvements-070926.md), [ai/13](../ai/13-product-ai-trade-journal-loop-070926.md) |
| **Type** | ENHANCE (community track record — not fundamentals RankingsLeaderboard) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Surface **who has a credible closed-trade record** on `/feed` (TipRanks-lite): server leaderboard by win rate / P&L, author badges on cards — with honest sample-size rules shared with enh/13–14.

### Cache / DB compliance
DB-only aggregates on `trade_posts` + `users`. **No** Yahoo/FMP. Optional TTLCache **5m** on leaderboard response. Do **not** overload `sort=top` (likes). Not Redis.

---

## 1. Executive summary (rescoped)

**Already present (do not rebuild):**
- Profile stats SQL in `feed.ts` L408–440 — `wins` / `losses` / `closed` / `winRate` / `totalPnl` (status **`CLOSED` only**)
- Feed `TopPerformers` — **client** aggregate on loaded posts (`feed.tsx` L114–141); min **n≥2**; UI shows WR+PnL but **hides `resolved`** (enh/13 owns show-n)
- `sort=top` = **likes** (`feed.ts` L94–96) — keep as social sort
- `RankingsLeaderboard` = **fundamental scores** — different product; do not reuse name/route

**Do:**
1. **New** `GET /api/feed/leaderboard?sort=winRate|pnl` — mirror profile aggregate, `HAVING closed >= 5`, limit 50
2. Feed tab or panel: **Top analysts** (server list) — distinct from Recent / likes-top
3. `AuthorBadge` on `TradeCard` when author stats available (“72% · 12 closed”) — batch or embed from leaderboard/profile cache
4. Align sample rules with enh/13–14: leaderboard **≥5 closed**; TopPerformers may stay ≥2 with low-n styling (enh/13)
5. Click row → `/profile/:username`

**Do not:** KYC verified badges; weight algo picks by analyst; public unauth leaderboard; fork profile StatsBar into a second product (enh/14).

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Trust needs community ranking | Profile has stats only on `/profile/:user` |
| TopPerformers is incomplete | Client-only on current page posts; n≥2 L131; **n not shown** L168–173 |
| `sort=top` ≠ win rate | `feed.ts` L94–96 orders by like count |
| Sample honesty | enh/13: show n, warn n&lt;5; enh/14: StatsBar “based on N closed” |
| Name collision risk | `rankings-leaderboard.tsx` = fundamentals — must not confuse |

### Semantics trap (fix in impl)
| Surface | Closed definition today |
|---|---|
| Profile SQL | `status = 'CLOSED'` only (L412–414) |
| TopPerformers client | Also `EXPIRED_WIN` / `EXPIRED_LOSS` (L122–126) |

**Leaderboard must pick one** — prefer **profile SQL semantics** (`CLOSED` + `resolved_pnl`) and document; optionally later unify TopPerformers (enh/13) to match.

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | `GET /api/feed/leaderboard` — auth session; `?sort=winRate\|pnl`; `closed >= 5` |
| W2 | Feed UI: Top analysts table/panel (rank, user, win%, PnL, n) |
| W3 | `AuthorBadge` optional prop on `TradeCard` |
| W4 | Empty state when &lt;1 user meets n≥5 |
| W5 | Cross-link enh/13 TopPerformers n display (don’t block if enh/13 not shipped) |

### Out of scope
| Item | Reason |
|---|---|
| Overload `sort=top` | Likes stay likes |
| Verified / paid badges | No KYC |
| Unauthenticated public board | Invite-only app |
| Fundamentals RankingsLeaderboard changes | Wrong domain |
| Full Tradervue analytics | enh/14 / ai/13 |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Profile aggregate | `feed.ts` L408–440 |
| `fetchPosts` likes sort | L94–96 |
| TopPerformers | `feed.tsx` L114–183; used ~L409 |
| Min n=2, hide n in UI | L131; L168–173 |
| TradeCard has username, no badge | `TradeCard.tsx` L6–34 props |
| StatsBar on profile | `profile.tsx` L552–578 |
| No `/feed/leaderboard` route | Grep routes — only profile/posts/… |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/api-server/src/routes/feed.ts` | Add `GET /feed/leaderboard` |
| **P0** | `artifacts/stock-compare/src/pages/feed.tsx` | Top analysts panel/tab |
| **P1** | `components/TradeCard.tsx` | Optional `authorStats` / `AuthorBadge` |
| **P2** | Optional `lib/ttl-cache.ts` register | 5m cache key `feed-leaderboard` |
| — | `rankings-leaderboard.tsx` | **Do not touch** |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| enh/13, enh/14 packs | Sample-size UX contract |
| Profile stats block | Reuse SQL pattern — don’t change profile response shape unless needed |

### 4.4 Paste-ready SQL shape

```sql
-- Mirror profile stats; group all users
SELECT u.id, u.username, u.avatar_url,
  SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) AS closed,
  SUM(CASE WHEN status = 'CLOSED' AND resolved_pnl > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN status = 'CLOSED' AND resolved_pnl <= 0 THEN 1 ELSE 0 END) AS losses,
  SUM(resolved_pnl) FILTER (WHERE status = 'CLOSED') AS total_pnl
FROM trade_posts tp
JOIN users u ON u.id = tp.user_id
GROUP BY u.id
HAVING SUM(CASE WHEN status = 'CLOSED' THEN 1 ELSE 0 END) >= 5
ORDER BY (wins::float / NULLIF(wins+losses,0)) DESC NULLS LAST  -- or total_pnl
LIMIT 50
```

Auth: same `requireAuth` / session as other feed routes.  
Response: `{ users: [{ username, avatarUrl, closed, wins, losses, winRate, totalPnl }] }`.

### 4.5 Sample-size contract (shared)

| n closed | Leaderboard (this task) | TopPerformers (enh/13) | Profile StatsBar (enh/14) |
|---|---|---|---|
| 0–1 | Excluded | Excluded (&lt;2) | Show — / low sample |
| 2–4 | **Excluded** | Show + warn | Show + warn |
| ≥5 | Eligible | Show normal | Show normal |

### 4.6 Acceptance criteria

- [ ] `GET /api/feed/leaderboard` returns only users with closed ≥5
- [ ] `sort=winRate` and `sort=pnl` work; default winRate
- [ ] Feed UI distinct from likes `sort=top`
- [ ] Does not change fundamentals `RankingsLeaderboard`
- [ ] Author badge shows n when present
- [ ] Win-rate formula matches profile (`CLOSED` + pnl sign) — documented
- [ ] api-server + stock-compare typecheck

### 4.7 Suggested commit message

`feat(feed): analyst leaderboard by closed-trade win rate`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| enh/13 | Soft — TopPerformers n UX; coordinate sample copy |
| enh/14 | Soft — StatsBar n; don’t duplicate leaderboard page |
| ai/13 | Soft — journal tags later |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- `feed.ts` + feed page + optional TradeCard
- Rollback: remove route + UI; profile/TopPerformers unchanged

### 2. Bug introductions
- **EXPIRED_* vs CLOSED** mismatch → leaderboard ≠ TopPerformers — pick profile semantics
- Small-n gaming if threshold lowered — keep ≥5 on server
- Catch: user with 5+ CLOSED appears; likes sort still works

### 3. Performance
- One GROUP BY; optional 5m TTLCache; no vendor I/O

### 4. Workflow
- Browse Top analysts → open profile → follow ideas with known n

### 5. Drift
- Paired: leaderboard SQL ↔ profile stats ↔ TopPerformers closed definition ↔ enh/13–14

**Do not:** overload `sort=top`; touch RankingsLeaderboard; KYC badges.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Key:** New `/feed/leaderboard` (not likes); ≥5 closed; align n UX with enh/13–14; fix CLOSED vs EXPIRED semantics explicitly.
