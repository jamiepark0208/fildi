# contextual-score-explanations

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | ui (+ thin frontend hook; no API changes v1) |
| **Effort** | M (~1–2 build sessions) |
| **Created** | 2026-07-09 |
| **Source** | competitive-ux-research |
| **Related** | [2-onboarding](2-onboarding-product-tour-070926.md), [ai/11 product-ai-explain-csp](../ai/11-product-ai-explain-csp-070926.md) (**hard consumer**), [enh/20 scorecard-guide](../enhancements/20-scorecard-guide-improvements-070926.md), [4-home](4-home-dashboard-redesign-070926.md) |
| **Type** | ENHANCE (extract duplicate Why → shared component) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Scores explain themselves at the decision moment — static one-liner + optional on-demand AI — so CSP traders don’t homework-trip to the guide.

### Cache / DB compliance
No new API routes v1. Reuse `POST /api/explain/score`. Cache AI text in **sessionStorage** only (`fildi_explain_{scoreType}_{ticker}`). No Redis/DB. No auto-fetch on popover open.

---

## 1. Executive summary (rescoped)

**Do not** extend explain API for `stock`/`option`, rename breakdown `ScoreBadge`, server-side explain cache, or auto-Haiku on hover.

**Do** ship `ExplainableScore` + `useScoreExplanation` + `score-summary-copy.ts`; refactor both leaderboard Why paths into the hook; wire stock-cards / scanner signal / TradeCard (static); add `?tab=` reader on guide. **ai/11** consumes this component — do not re-implement there.

---

## 2. Why (line-level evidence)

| Requirement | Evidence |
|---|---|
| Duplicate fundamental Why fetch | `rankings-leaderboard.tsx` `fetchExplanation` L104–155 — in-memory `Record`, no sessionStorage |
| Duplicate technical Why fetch | `technical.tsx` `TechnicalLeaderboard.fetchExplanation` L308–364 — `Map` in component state |
| API already limited | `explain.ts` L48 — `scoreType: "fundamental" \| "technical"`; Haiku `max_tokens: 200` L136–138 |
| Scores shown without meaning | `stock-cards.tsx` L104–108 — raw `totalScore`; scanner `SignalBadge` L147–156 / L517 — no copy |
| Guide has no deep link | `scorecard-explanation.tsx` L22 — `useState("fundamental")` only; **no** `?tab=` reader |
| Name collision risk | `stock-breakdown.tsx` local `ScoreBadge` L120–128 (1–5 snowflake) |
| TradeCard signal | `TradeCard.tsx` L98 / L184 — local `SignalBadge` for `signalAtEntry` |
| Shared component missing | Grep: **zero** `ExplainableScore` / `useScoreExplanation` |
| ai/11 blocked on this | `ai/11` Related + “Blocked until ExplainableScore exists” |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | `lib/score-summary-copy.ts` — one-liners + `guideTabFor()` |
| W2 | `hooks/useScoreExplanation.ts` — sessionStorage + payload builders from both leaderboards |
| W3 | `components/ExplainableScore.tsx` — popover, DQ chip, Explain more (fund/tech only), guide link |
| W4 | Refactor `rankings-leaderboard.tsx` + `technical.tsx` TechnicalLeaderboard |
| W5 | Wire: `stock-cards.tsx`, scanner `SignalBadge`/tech score, `TradeCard` signal (static) |
| W6 | Guide: read `?tab=fundamental\|technical\|options` on mount |
| W7 | Sidebar label “Scorecard Guide” → **“Scoring Reference”** (label only) |

### Out of scope
| Item | Owner |
|---|---|
| Extend API for stock/option explain | Later / ai/11 design |
| CSP scanner AI wiring beyond shared component | [ai/11](../ai/11-product-ai-explain-csp-070926.md) |
| Watchlist breakdown header scores | Phase 2 / enh/12 |
| Server Redis explain cache | Rejected v1 |
| Auto-fetch AI on open | Cost / rate limits |
| Export name `ScoreBadge` | Collision with breakdown |

### Score type matrix

| `scoreType` | Static | AI Explain more | Guide tab |
|---|---|---|---|
| `fundamental` | Yes | Yes | `fundamental` |
| `technical` | Yes | Yes | `technical` |
| `signal` | GO/WATCH/NO copy | No | `technical` |
| `stock` / `option` | Yes | No (v2) | `options` |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Fundamental POST body shape | `rankings-leaderboard.tsx` L122–144 (`fundamentalData` + families/metrics) |
| Technical POST body shape | `technical.tsx` L325–353 (`technicalData` + componentScores) |
| API route + fallback string | `explain.ts` L119–146 — catch returns fixed explanation |
| In-memory only today | Leaderboards: `useState` Maps/Records — lost on nav; no sessionStorage |
| ScoreBadge collision | `stock-breakdown.tsx` L120 |
| Guide tabs exist | `scorecard-explanation.tsx` L22, L82 |
| Sidebar guide label | `sidebar.tsx` L70 `"Scorecard Guide"` |
| dataQuality on rankings | `computeRankingsV2` → `dataQuality` good/partial/insufficient (`rankings.ts` ~L462) |
| Lessons | grep explain/sessionStorage — **none** |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `src/lib/score-summary-copy.ts` | **New** |
| **P0** | `src/hooks/useScoreExplanation.ts` | **New** |
| **P0** | `src/components/ExplainableScore.tsx` | **New** |
| **P0** | `src/components/rankings-leaderboard.tsx` | Replace Why with ExplainableScore; delete local fetch |
| **P0** | `src/pages/technical.tsx` | Same for TechnicalLeaderboard |
| **P1** | `src/components/stock-cards.tsx` | Wrap score |
| **P1** | `src/pages/options-scanner.tsx` | Wrap signal (+ tech score if present); `stopPropagation` |
| **P1** | `src/components/TradeCard.tsx` | Static signal ExplainableScore |
| **P1** | `src/pages/scorecard-explanation.tsx` | `?tab=` on mount |
| **P2** | `src/components/sidebar.tsx` | Label → Scoring Reference |
| **P2** | INDEX | done when shipped |

### 4.3 Read-not-modify

| Path | Why |
|---|---|
| `artifacts/api-server/src/routes/explain.ts` | Contract only — **no edit v1** |
| `lib/scorecard-guide-metadata.ts` | Tone reference; don’t duplicate full rows |
| `lib/stock-scorer.ts` | dataQuality types |
| `ai/11` task | Consumer — owns scanner CSP AI placement after this ships |
| `stock-breakdown.tsx` ScoreBadge | Do not rename |

### 4.4 Static copy (paste-ready)

```typescript
export const SCORE_SUMMARY = {
  fundamental: "0–100 peer-relative score across Value, Growth, Quality, and Safety.",
  technical:   "0–100 technical setup score — higher means better timing for selling puts.",
  signal: {
    GO:    "RSI and MFI conditions favor entering a cash-secured put.",
    WATCH: "Near entry conditions — monitor for confirmation.",
    NO:    "Entry conditions not met — wait for better setup.",
  },
  stock:  "Combined stock score: technical + fundamental + entry timing + best option + tag.",
  option: "Strike-level score for premium, buffer, IV, and stock quality at this expiry.",
} as const;
```

Cache key: `fildi_explain_{scoreType}_{ticker}`.

### 4.5 Acceptance

- [ ] Popover opens with static text; **no** network until “Explain more”
- [ ] Explain more fund + tech works; second open same session hits sessionStorage
- [ ] `rg fetchExplanation` in stock-compare → **0** (moved to hook)
- [ ] `rg ExplainableScore` → ≥5 files
- [ ] Signal / stock / option: no Explain more button
- [ ] Guide link opens correct `?tab=`
- [ ] Sidebar shows “Scoring Reference”
- [ ] typecheck + build pass
- [ ] explain.ts unchanged

### 4.6 Suggested commit message

`feat(ui): add ExplainableScore with session-cached AI explain`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| Existing `/api/explain/score` | Hard — reuse |
| **ai/11** | Downstream consumer — after or same PR with clear ownership |
| Seq 2 tour step 4 | Soft — update “badges coming soon” copy |
| enh/20 | Soft — deep-link presets; this owns inline popovers |
| Seq 4 / 5 / 6 | Soft — prefer ExplainableScore on pick cards when present |

---

## 5. Impact & Risk

### Blast radius
Leaderboard UX changes (Why → popover). Scanner row click must `stopPropagation`. Rollback = revert new files + consumer diffs.

### Bug risks
- AI on every open → **forbidden**; click-only
- Name `ScoreBadge` → use **ExplainableScore** only
- 429 / missing key → static copy always visible; API already returns fallback string
- Table overflow clipping → `side="top"` + collisionPadding
- False confidence: AI narrative vs numeric scores — static first; label AI as optional deepen

### Performance / cost
Haiku only on click; sessionStorage prevents repeat; generalLimiter 300/15min — typical ≤1 explain/ticker/session.

### Drift
Payload builders must stay aligned with `explain.ts` types. ai/11 must import shared hook — no third Why implementation.

**Do not:** new explain route; Redis; auto-fetch; duplicate component in ai/11.

---

## Review (2026-07-09) — task-reviewer

**Verdict:** APPROVE — **Status ready**; hard dep for ai/11

**Lenses:** PM Keep | UX Keep | Eng Keep (extract) | BA Keep | User Keep (trust: static first)

**Need:** Inline meaning at CSP decision points; kill duplicate Why.

**Code reality:** Dual fetchExplanation verified; ExplainableScore absent; API fund/tech only.

**Better:** As written — enhance-first extract; defer stock/option AI.
