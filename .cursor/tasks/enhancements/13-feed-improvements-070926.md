# feed-improvements

| Field | Value |
|---|---|
| **Status** | ready |
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
Discover and validate CSP ideas from traders you trust — before copying a strike. Improve trust signals on the existing feed; do not rebuild CRUD.

### Cache / DB compliance
Reuse `GET /api/feed/posts` (+ like/comment/close/delete). Trending = **client aggregate**. No new feed routes. No Redis. No TipRanks import.

---

## 1. Executive summary (rescoped)

**Do not** rebuild post system or add `/api/feed/trending`.

**Do:**
1. **TopPerformers:** show closed count `n` (field `resolved` already computed); grey / warn when `n < 5` (keep min ≥2 to appear, but label low-n)
2. **TradeCard:** make `notes` a prominent “Why now” thesis (not muted italic only)
3. **Validate in scanner** CTA → `/options-scanner` with ticker
4. Optional: **Trending in feed** row — top 5 tickers by open posts in loaded window / last 7d — client-side only

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

## 5. Impact & Risk Analysis

### 1. Blast radius
- feed.tsx + TradeCard (also used on profile)
- Rollback: revert UI

### 2. Bug introductions
- TradeCard CTA on profile may be unwanted — allow `showValidateCta` prop default true on feed only
- Scanner query param ignored — verify options-scanner reads it
- Catch: feed card with notes; TopPerformers shows n

### 3. Performance
- Client aggregates only

### 4. Workflow
- Trust filter before copy-trade

### 5. Drift
- Paired: TopPerformers n ↔ profile StatsBar ↔ leaderboard task

**Do not:** new APIs; TipRanks; Redis.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Was:** draft. **Key:** `resolved` already computed — just surface it; thesis + scanner CTA.
