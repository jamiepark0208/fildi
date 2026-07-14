# todays-top-picks-feed

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M |
| **Created** | 2026-07-09 |
| **Source** | competitive-research |
| **Research** | [competitive-ux-research](1-competitive-ux-research-070926.md) |
| **Related** | [home-dashboard](4-home-dashboard-redesign-070926.md) (**share FeaturedPickCard**), [scanner-simplified](5-scanner-simplified-view-070926.md) (`buildReasoning` extract), [contextual-score](3-contextual-score-explanations-070926.md) (soft), [technical-scorecard](../enhancements/15-technical-scorecard-improvements-070926.md) |
| **Type** | ENHANCE (dedicated picks surface — not new ranking engine) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Answer *"What are today’s best CSP ideas?"* in one glance — ranked GO cards with headline reasoning, deep-link to scanner/scorecard.

### Cache / DB compliance
**Client-only v1.** Reuse watchlist/scorecard React Query keys already used on home/scanner. **No** options fetch on mount (strike only if RQ cache already warm). **No** `GET /api/home/featured-picks` in v1 (same defer as seq 4). No Redis / no outcome DB.

---

## 1. Executive summary (rescoped)

**Already present / planned elsewhere:**
- Seq 4 owns Today shell on `/` and defines shared `FeaturedPickCard` + `useFeaturedPicks`
- `buildReasoning` lives in scanner only today (`options-scanner.tsx` L123–143) — extract owned by seq 5 / 4
- Grep: **zero** `FeaturedPickCard` / `useFeaturedPicks` on disk yet

**Do (this task):**
1. Dedicated **Top picks** route or feed section (prefer `/picks` or home-adjacent list — not a second ranking engine)
2. Implement / harden shared `FeaturedPickCard` + `useFeaturedPicks` if seq 4 hasn’t shipped yet — **one component, two consumers**
3. Rank: GO first → tech/stock score desc; cap ≤10 (home keeps ≤3)
4. Card: ticker, signal, tech score, `buildReasoning` headline, CTA → `/options-scanner?ticker=` (enh/15) and/or scorecard
5. Empty / all-NO state with plain copy + link to scanner filters

**Do not:** admin pin UI; outcome tracking DB; prefetch option chains; duplicate home API; invent TipRanks-style “analyst pick of day.”

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| No dedicated picks surface | Grep empty for FeaturedPick / TopPicks page |
| Home still compare-framed | `home.tsx` title “Fundamental Analysis” (seq 4) |
| Reasoning trapped in scanner | `buildReasoning` L123; 1 caller (expanded row) |
| Competitive gap | Covers / TipRanks featured ideas; Koyfin morning glance |
| Share with home | Seq 4 Related explicitly shares card + hook |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | `useFeaturedPicks(limit)` — derive from scorecard/watchlist cache; pure client |
| W2 | `FeaturedPickCard` — presentational; uses `buildReasoning` from `lib/scanner-reasoning.ts` |
| W3 | Top picks page/section — list ≤10; sort GO→WATCH; hide NO by default |
| W4 | Deep links: scanner `?ticker=` + optional scorecard |
| W5 | Strike/income line **only if** options RQ entry already cached — else “Open scanner for strikes” |
| W6 | Soft: ExplainableScore badge if seq 3 shipped |

### Out of scope
| Item | Reason |
|---|---|
| `GET /api/home/featured-picks` | Defer with seq 4 |
| Admin pin / editorial queue | v2 |
| Outcome / hit-rate DB for picks | No schema; not TipRanks |
| Options chain prefetch for all GO | Rate-limit |
| Duplicate RankingsLeaderboard | Fundamentals ≠ CSP picks |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| No FeaturedPick* files | Glob empty |
| `buildReasoning` scanner-only | `options-scanner.tsx` L123–143; render L575 |
| Seq 4 contract | Pack §1–3: share card; client v1; no home API |
| Seq 5 extract | `lib/scanner-reasoning.ts` — **do first** if not done |
| Scanner deep-link | enh/15 owns `?ticker=` — keep compatible |
| Lessons | No new Yahoo on mount (home/picks) |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `lib/scanner-reasoning.ts` | Ensure extract exists (may be seq 5) |
| **P0** | `components/FeaturedPickCard.tsx` | **New** (or extend if seq 4 landed) |
| **P0** | `hooks/useFeaturedPicks.ts` (or `lib/`) | Derive GO list from scorecard query |
| **P0** | `pages/picks.tsx` **or** feed/home section | List UI |
| **P1** | `App.tsx` / sidebar | Route + nav item if new page |
| — | API | Prefer no change |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| seq 4 pack | Layout ownership of ≤3 on home |
| `options-scanner.tsx` | Signal / scorecard shape |
| enh/27 rankings materialization | P3 — do not depend |

### 4.4 Paste-ready selection logic (English)

```
rows = scorecardQuery.data (watchlist universe)
filter signal === 'GO' (optional include WATCH)
sort by techScore / stock score desc
slice(0, limit)  // home: 3, picks page: 10
headline = buildReasoning(row, cachedIv ?? null, regime)
strikeLine = optionsCache.get(ticker)?.best ?? null  // never fetch here
```

### 4.5 Acceptance criteria

- [ ] Picks list shows ≤10 GO (or empty state) without new API
- [ ] Same `FeaturedPickCard` used on home (≤3) when seq 4 ships
- [ ] No options network on picks mount (DevTools)
- [ ] Card CTA opens scanner focused on ticker
- [ ] Uses shared `buildReasoning` (not copy-pasted)
- [ ] stock-compare typecheck

### 4.6 Suggested commit message

`feat(picks): client top-GO feed with shared FeaturedPickCard`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **seq 5** (or 4) extract | Hard — need `scanner-reasoning.ts` |
| **seq 4** | Soft parallel — share component; either can land first if extract done |
| seq 3 | Soft ExplainableScore |
| enh/15 | Soft deep-link |

---

## 5. Impact & Risk Analysis

- Sort diverging from scanner Simple needs explicit documentation ("picks = GO by tech score")
- Must reuse the same staleTime as the scanner source or picks go stale independently
- Zero new vendor calls expected — cache-only
- Paired with FeaturedPickCard ↔ home seq 4 ↔ scanner-reasoning ↔ seq 5 Simple — keep in sync

**Do not:** home API; admin pin; outcome DB; chain prefetch.

---

## Review: APPROVE — ready. Client GO list + shared card with seq 4; defer API/pin/outcomes; extract reasoning first.
