# profile-track-record-improvements

| Field | Value |
|---|---|
| **Status** | done* — Phase A shipped 2026-07-14 (A1-A4); Phase B (tags) still open, design-gated with ai/13 |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M (Phase A); tags = design-gated with ai/13 |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [feed-improvements](13-feed-improvements-070926.md), [analyst-leaderboard](../new_app_features/7-analyst-leaderboard-track-record-070926.md), [ai/13](../ai/13-product-ai-trade-journal-loop-070926.md), [portfolio](8-portfolio-analysis-improvements-070926.md) |
| **Type** | ENHANCE (+ NEW tags only after design) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Public credibility for CSP ideas; organize conviction (buckets); learn from closed trades — TipRanks-lite sample honesty without a second leaderboard product.

### Cache / DB compliance
Reuse `GET /api/feed/profile/:username`, buckets APIs, existing posts. Tags need **explicit migration** co-owned with [ai/13](../ai/13-product-ai-trade-journal-loop-070926.md). No Redis. No broker OAuth.

---

## 1. Executive summary (rescoped)

**Do not** build Tradervue-scale analytics or duplicate [new_app_features/7](../new_app_features/7-analyst-leaderboard-track-record-070926.md).

**Do (Phase A — UI only):**
1. **StatsBar:** show “based on N closed” using `stats.closed` (already in API type); optional 90d / all-time toggle **if** posts array can filter client-side — else all-time only v1
2. **Bucket chip → scanner:** “Show in scanner” for tickers in that bucket
3. Monthly summary card on **own** profile — client aggregate of closed posts v1

**Phase B (design-gated with ai/13):**
- Optional close tags (rule break, early exit, assigned, perfect) — **same schema as journal**, not a profile-only table

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Stats hide sample size | `StatsBar` L552–573 — Win Rate without “N closed”; `stats.closed` exists on `ProfileData` L24 |
| Buckets work | BULLISH/NEUTRAL/BEARISH + `GET /api/feed/buckets/:username` |
| Close is PnL-only | TradeCard close → `closePremium` (ai/13) |
| Leaderboard separate | new_app_features/7 owns community leaderboard page |

---

## 3. What (build scope)

### Phase A — in scope
| # | Work |
|---|---|
| A1 | StatsBar subtitle/footnote: `based on {closed} closed` |
| A2 | Grey win rate when closed &lt; 5 (align with feed TopPerformers rules) |
| A3 | Bucket → “Open in scanner” with ticker list / first ticker deep link |
| A4 | Own-profile monthly PnL / win summary from `posts` client-side |

### Phase B — design-gated
| # | Work |
|---|---|
| B1 | Agree tag enum + storage with ai/13 Phase 0 |
| B2 | Close form optional tags; profile shows tag rates with n |

### Out of scope
| Item | Reason |
|---|---|
| Full leaderboard page | new_app_features/7 |
| 100+ Tradervue reports | Forbidden |
| Broker sync | Forbidden |
| Writing lessons.md | ai/3 / R5 |
| Ad-hoc tag table in UI-only PR | Forbidden |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Profile route | `/profile/:username` — `profile.tsx` |
| Stats shape | L24 — `closed`, `winRate`, `wins`, `losses`, `totalPnl`, … |
| StatsBar | L552–578 — no closed footnote |
| Buckets | L447+ bucket UI; API `/buckets/:username` |
| TradeCard reuse | Profile imports TradeCard |
| Journal tags | Not on `trade_posts` yet (ai/13) |

### 4.2 Files to modify (Phase A)

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/profile.tsx` | StatsBar n; bucket scanner CTA; monthly card |
| **P1** | `TradeCard.tsx` | Only if close UI needs tag hooks later — Phase B |
| — | `routes/feed.ts` profile stats | Prefer no change if `closed` already returned |

### 4.3 Files to read but **not** modify (Phase A)

| Path | Why |
|---|---|
| `feed.ts` profile aggregate SQL | Confirm `closed` semantics |
| enh/13 feed TopPerformers | Shared n thresholds |
| ai/13 | Tag schema owner |
| new_app_features/7 | Don’t fork leaderboard |

### 4.4 Sample-size rules (shared with enh/13)

| n closed | Win rate display |
|---|---|
| 0 | “—” |
| 1–4 | Show rate + “low sample (n)” muted |
| ≥ 5 | Normal |

### 4.5 Acceptance criteria

**Phase A**
- [ ] StatsBar shows N closed
- [ ] Low-n styling when closed &lt; 5
- [ ] Bucket control can navigate to scanner with ticker context
- [ ] No new leaderboard page
- [ ] No schema migration in Phase A
- [ ] stock-compare typecheck

**Phase B**
- [ ] Design checklist with ai/13 complete before migration
- [ ] lessons.md untouched

### 4.6 Suggested commit messages

Phase A: `feat(profile): show closed-sample size and bucket scanner links`  
Phase B: after ai/13 design — `feat(feed): optional journal tags on close`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **enh/13** | Shared n UX |
| **ai/13** | Hard for tags |
| **new_app_features/7** | Leaderboard — link, don’t duplicate |
| enh/8 | Portfolio journal display may consume same tags |

---

## 5. Impact & Risk Analysis

- 90d toggle without a server-side filter would give wrong stats — ship all-time only unless the posts window is complete
- Bucket scanner needs a documented behavior for multiple tickers (or pass just one)
- Paired with feed TopPerformers n ↔ ai/13 tags ↔ leaderboard — keep in sync

**Do not:** Tradervue clone; OAuth; lessons.md; solo tag schema.

---

## Review: APPROVE — Phase A ready, tags with ai/13. `stats.closed` already in type — surface it; scanner from buckets.
