# feed-improvements

| Field | Value |
|---|---|
| **Status** | done* — shipped 2026-07-14 (W1-W3, W5-W7 below); W4 trending strip still open |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [profile-track-record](14-profile-track-record-improvements-070926.md), [analyst-leaderboard](../new_app_features/7-analyst-leaderboard-track-record-070926.md), [social-sentiment](../new_app_features/9-social-sentiment-polish-070926.md) (**owns TrendingTickers**; W4 = same widget), [ai/13](../ai/13-product-ai-trade-journal-loop-070926.md) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Rescoped 2026-07-14: the Feed page (opened via the FILDI home icon) needs to read as a real social feed, not a filtered data table. Remove the All/Open/Wins/Losses/Closed status pills entirely, keep the Recent/Top toggle but fix a live bug where switching it eventually shows stale/wrong results, and redesign the visual language (post header, thesis notes, action bar) to look like a legitimate social app (Instagram/LinkedIn-style). Trust-signal items from the original scope (TopPerformers n, thesis prominence, scanner CTA) are folded in since they fit naturally. Do not rebuild like/comment/close/delete CRUD or add new API routes.

### Cache / DB compliance
Reuse `GET /api/feed/posts` (+ like/comment/close/delete). No new feed routes. No Redis. No TipRanks import. `status` param is dropped from the frontend request only — backend filter stays intact/optional, unused.

---

## 1. Executive summary (rescoped 2026-07-14)

**Do not** rebuild post system, add `/api/feed/trending`, or touch enh14 (profile) / enh21 (settings) — unrelated pages, left in ready queue.

**Do:**
1. **Remove status filter UI** — `StatusFilter`/`STATUS_MAP`/`STATUS_PILLS` and the pill row disappear from `feed.tsx`; stop sending `status` in the request
2. **Fix Recent/Top bug** — replace the hand-rolled `offset`/`setAllPosts`-inside-`queryFn` pagination (feed.tsx L229-289) with `useInfiniteQuery`, so React Query owns cancellation per query key instead of racing manual state
3. **Post-header redesign** (`TradeCard.tsx`) — bigger avatar, bold clickable username + timestamp as a byline (like a feed post header); ticker/status/signal badges move to a secondary line
4. **Thesis notes** — `notes` gets a labeled "Thesis" treatment instead of plain italic muted text
5. **Full-width action bar** — like/comment row gets more breathing room; add a "Validate in scanner" CTA → `/options-scanner?ticker=...`
6. **TopPerformers:** show closed count `n` (field `resolved` already computed); grey / warn when `n < 5`
7. Toolbar restyle — sort toggle becomes the primary control (segmented pill), search box kept as-is

Coordinate sample-size UX with [new_app_features/7](../new_app_features/7-analyst-leaderboard-track-record-070926.md) so leaderboard + feed don’t invent different n rules.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| TopPerformers hides n | `feed.tsx` L132–137 computes `resolved` but UI L168–173 shows only WR + PnL |
| Min sample | Filter `(wins+losses) >= 2` L131 — TipRanks-style significance needs visible n |
| Notes underplayed | `TradeCard.tsx` L239–242 italic muted |
| No scanner validate | No link on card today |
| Feed CRUD solid | filters, TradeCard, pagination — keep |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | TopPerformers: display `n={resolved}`; style warning if n &lt; 5 |
| W2 | TradeCard: thesis block when notes set (stronger typography / label “Thesis”) |
| W3 | “Validate in scanner” button → options-scanner with ticker query/state |
| W4 | Optional trending strip from current `posts` array |
| W5 | Align copy with profile StatsBar “based on N” (enh/14) |

### Out of scope
| Item | Reason |
|---|---|
| New feed API routes | Forbidden |
| TipRanks scrape | Forbidden |
| Redis trending | Forbidden |
| Journal tags on close | ai/13 / enh/14 design |
| Rebuild post CRUD | Forbidden |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| TopPerformers in feed.tsx | L114–183; used ~L409 |
| `resolved` in UserStat | L112, L137 — **not rendered** |
| TradeCard on feed | L381+ |
| Notes field | TradePost.notes; compose form textarea L80 |
| Close API | still `{ closePremium }` only — tags later |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/feed.tsx` | TopPerformers n + warn; optional trending |
| **P0** | `artifacts/stock-compare/src/components/TradeCard.tsx` | Thesis prominence + Validate CTA |
| **P1** | Scanner page | Accept ticker from query if not already |
| — | `routes/feed.ts` | Prefer no change |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| profile StatsBar | Sample-size copy consistency |
| new_app_features/7 | Leaderboard n rules |
| ai/13 | Close tags — not this PR |

### 4.4 Sample-size rules (shared)

| n closed | Display |
|---|---|
| &lt; 2 | Excluded from TopPerformers (today) |
| 2–4 | Show WR + **n** + “low sample” muted/grey |
| ≥ 5 | Normal emphasis |

### 4.5 Acceptance criteria

- [ ] TopPerformers shows closed trade count per user
- [ ] n &lt; 5 visually de-emphasized
- [ ] Notes render as clear thesis when present
- [ ] Validate in scanner navigates with ticker
- [ ] No new `/api/feed/*` routes
- [ ] Trending (if shipped) is client-only
- [ ] stock-compare typecheck

### 4.6 Suggested commit message

`feat(feed): show sample size on top performers and scanner validate CTA`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **enh/14** | Profile stats n copy |
| **new_app_features/7** | Leaderboard — shared n semantics |
| ai/13 | Tags later |

---

## 5. Risk notes

- `TradeCard.tsx` is shared with `profile.tsx` — the scanner CTA is hidden whenever `post.status !== "OPEN"`, so it won't show on resolved posts on either page.
- Scanner CTA uses `addToScannerShelf()` (existing localStorage hand-off helper, same one used from stock-breakdown/technical pages) rather than a query param — confirmed pattern already works.
- Paired with profile StatsBar (enh/14) and the leaderboard task on shared n-display semantics — don't diverge the low-sample threshold (`n < 5`).

**Do not:** new APIs; TipRanks; Redis.
