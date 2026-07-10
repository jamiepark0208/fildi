# stock-breakdown-sections-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | L (Phase A = M; analyst richness waits on enh/6) |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [analyst-data-persistence](6-analyst-data-persistence-070926.md), [ai/11](../ai/11-product-ai-explain-csp-070926.md), [new_app_features/3](../new_app_features/3-contextual-score-explanations-070926.md), [enh/33](33-csp-momentum-backtest-learning-research-070926.md) (catalyst SSOT / keyword expand — keep server `buildCatalysts` only; L-05) |
| **Type** | ENHANCE + FIX |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
One-page go/no-go research before selling a put — Simply Wall St–style scroll with FILDI scoring depth, without a second report product.

### Cache / DB compliance
Reuse `GET /api/stocks/breakdown` + `breakdownCache` (2h). Bump `BREAKDOWN_CACHE_VER` only if payload shape changes (today **5** — next is **6**). No Redis. No FMP PT on free tier. No N+1 Yahoo on render.

---

## 1. Executive summary (rescoped)

**Already present (enhance, don’t rebuild):**
- Snowflake + SectionCards + overview/chart
- `bullBullets` / `bearBullets` already in payload and UI (`stock-breakdown.tsx` ~1043+)
- Server `attachCatalysts` → `catalysts[]`; FE still has **duplicate** `buildCatalysts` (lesson **L-05**)
- Watchlist right panel embeds `<StockBreakdown ticker={selectedTicker} />`; orphan `/breakdown` route also exists

**Do (Phase A — no enh/6 required):**
1. **FIX:** Delete FE `buildCatalysts`; consume `catalysts[]` only
2. Promote earnings date in catalysts header
3. Header CTAs: **Open in scanner** + **Add to compare** (≤5 shelf)
4. Competitors → home compare links (≤5)
5. Tighten rewards/risks presentation (top 3+3 from existing bullets — optional explain click via ai/11 later)

**Defer to enh/6:** persisted U/D history UI richness; per-firm PTs (Track 2).

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Dual catalyst logic | `lib/catalysts.ts` + `catalysts-section.tsx` local copy; lessons.md L-05 |
| Orphan breakdown page | `App.tsx` `/breakdown`; watchlist already hosts full panel |
| No scanner handoff | No CTA in breakdown header today |
| PT by firm empty | `analystPriceTargets: []` server-side (enh/6) |
| Bull/bear exist | `buildBullBullets` / `buildBearBullets` in `stocks.ts` |

---

## 3. What (build scope)

### Phase A — in scope
| # | Work |
|---|---|
| A1 | Delete FE `buildCatalysts` / `analystLine` duplicate; require server `catalysts` |
| A2 | Earnings date prominent near catalysts title |
| A3 | Header actions: Scanner (`/options-scanner` + ticker), Compare (home shelf ≤5) |
| A4 | CompetitorsSection: link tickers into compare/home |
| A5 | Optional: collapse rewards/risks to top-of-page summary using existing bullets |
| A6 | Decide `/breakdown` UX: redirect to `/watchlist` with ticker **or** keep page but share identical header CTAs — pick one in PR (prefer watchlist as canonical) |

### Phase B — after enh/6 Track 1
| # | Work |
|---|---|
| B1 | Analyst Rating Changes from DB-backed actions |
| B2 | Track 2 PTs when available |

### Out of scope
| Item | Reason |
|---|---|
| New `/report` page | Forbidden |
| Rebuild snowflake math | Out of scope |
| Re-add FMP PT | Free tier empty |
| Redis | Forbidden |
| Parallel breakdown fetch | Forbidden |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| BREAKDOWN_CACHE_VER | `stocks.ts` = **5** |
| FE duplicate catalysts | `catalysts-section.tsx` L53–91; prefers `catalysts` prop if non-empty L106–107 |
| Watchlist embed | `watchlist.tsx` L368 `<StockBreakdown ticker={selectedTicker} />` |
| Orphan page | `pages/breakdown.tsx` + App route |
| Bull/bear UI | stock-breakdown ~1043–1051 |
| Lesson | `.cursor/context/lessons.md` L-05 — delete FE duplicate |

### 4.2 Files to modify (Phase A)

| Pri | Path | Change |
|---|---|---|
| **P0** | `catalysts-section.tsx` | Remove local builder; render `catalysts` (+ earnings header) |
| **P0** | `stock-breakdown.tsx` | Header CTAs; optional top summary |
| **P1** | `competitors-section.tsx` | Compare links |
| **P1** | `App.tsx` / `breakdown.tsx` | Redirect or unify with watchlist |
| — | `stocks.ts` breakdown | Prefer no change unless CACHE_VER bump needed |
| — | Snowflake scorers | No change |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `lib/catalysts.ts` | Canonical SSOT |
| enh/6 pack | Analyst persistence |
| ai/11 / new_app_features/3 | Optional ExplainableScore later |

### 4.4 Acceptance criteria

- [ ] Only one `buildCatalysts` definition (api-server)
- [ ] CatalystsSection with empty `catalysts` does not reimplement server logic (show empty / fallback message)
- [ ] Scanner CTA opens options-scanner with ticker context
- [ ] Compare CTA respects ≤5 shelf
- [ ] No FMP PT reintroduced
- [ ] No new breakdown fields required for Phase A narrative
- [ ] stock-compare typecheck

### 4.5 Suggested commit message

`fix(ui): dedupe catalysts and add breakdown scanner/compare CTAs`

### 4.6 Dependencies

| Dep | Relation |
|---|---|
| **enh/6** | Phase B analyst/PT |
| L-05 | Must fix duplicate when touching this area |
| ai/11 | Optional explain on scores |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- breakdown + catalysts-section + maybe routing
- Rollback: restore FE fallback temporarily if server catalysts missing (shouldn’t be)

### 2. Bug introductions
- Empty catalysts if attachCatalysts skipped on cache path — verify `attachCatalysts(cached)` still runs (it does on cache hit)
- Redirect loses ticker — pass query/state carefully
- Catch: watchlist select ticker; catalysts match server; scanner CTA works

### 3. Performance
- No new fetches

### 4. Workflow
- Research → scanner handoff in one screen

### 5. Drift
- Paired: catalysts.ts ↔ FE props ↔ L-05

**Do not:** second snowflake; `/report`; Redis; FMP PT.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — Phase A ready  
**Was:** draft. **Key:** bull/bear already exist; real FIX is L-05 catalyst dedupe + CTAs.
