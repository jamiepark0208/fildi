# home-dashboard-redesign

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P0 |
| **Area** | ui (+ optional thin API aggregator — **defer**; client v1) |
| **Effort** | L (~2–3 sessions) |
| **Created** | 2026-07-09 |
| **Source** | competitive-ux-research |
| **Related** | [3-contextual-score-explanations](3-contextual-score-explanations-070926.md) (nice-to-have on pick cards), [6-todays-top-picks-feed](6-todays-top-picks-feed-070926.md) (**share FeaturedPickCard**), [2-onboarding](2-onboarding-product-tour-070926.md) (bump `TOUR_VERSION` after), [5-scanner-simplified](5-scanner-simplified-view-070926.md) |
| **Type** | ENHANCE (layout + shared extract; not new ranking engine) |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) |

### Purpose
Answer *"What should I look at today for put selling?"* on `/` — macro context → featured GO ideas → quick links → collapsible full rankings.

### Cache / DB compliance
Reuse `regimeQuery` (`staleTime: 1h`), existing watchlist/scorecard React Query keys. **No** new Yahoo/options fetches on home mount. **No** ranking materialization (enh/27 P3). **Do not** expand or remove `FUNDAMENTAL_WATCHLIST` (BUG-01 peer norm) — hide from UX only. Prefer **client** featured-picks derivation v1; defer `GET /api/home/featured-picks`.

---

## 1. Executive summary (rescoped)

**Do not** rebuild rankings, add daily-brief AI on home, fetch all option chains for picks, or invent a second home API in v1.

**Do** recompose `home.tsx` into a Today shell: macro strip (existing `/api/regime/macro`), top-3 GO cards via shared `FeaturedPickCard` + extracted `buildReasoning`, quick links, collapsible compare UI. Extract `buildReasoning` → `lib/scanner-reasoning.ts` **before** importing from the scanner page (also unblocks seq 6).

---

## 2. Why (line-level evidence)

| Requirement | Evidence |
|---|---|
| Home is compare tool, not “today” | `home.tsx` L148 — title **“Fundamental Analysis”** |
| Regime already fetched on home | `regimeQuery` L82–91 — `GET /api/regime/macro`, `staleTime: 60 * 60 * 1000` |
| Hardcoded peer universe (must keep) | `FUNDAMENTAL_WATCHLIST` L16–20 + peer-groups query L71–78 — BUG-01 comment L14–15 |
| Rankings path exists | `fundamentals-rankings` query L106–115; `computeRankingsV2` in lib |
| Featured picks / Today shell missing | Grep: **zero** `FeaturedPickCard` / `TodayDashboard` |
| Reasoning trapped in scanner page | `options-scanner.tsx` `buildReasoning` L123–143 — **1 caller** (scanner only) |
| Competitive gap | Research: Koyfin morning dash; Covers featured pick; Finviz glance |
| Seq 6 shares card | [6-todays-top-picks](6-todays-top-picks-feed-070926.md) — same `FeaturedPickCard` / `useFeaturedPicks` |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Page title → **Today** + CSP subtitle |
| W2 | `MacroRegimeStrip` — compact chip from existing `regimeQuery` (+ 1-line CSP implication); link `/macro` |
| W3 | `FeaturedPickCard` × ≤3 — top GO from watchlist scorecard cache; headline via `buildReasoning` |
| W4 | `QuickLinks` — Scanner, Watchlist, Macro |
| W5 | Collapsible “Full fundamental rankings” — default **collapsed** if picks exist; contains current StockCards / charts / leaderboard / metrics |
| W6 | Extract `buildReasoning` → `lib/scanner-reasoning.ts`; scanner imports shared |
| W7 | Demote hardcode from UX copy only — keep constant for peer norm |

### Out of scope
| Item | Reason |
|---|---|
| `GET /api/home/featured-picks` | Defer — client derivation v1; seq 6 may revisit |
| Full options chains on home mount | Rate-limit risk — show pick without strike or lazy 1 chain later |
| Daily brief AI widget | Portfolio / enh/9 |
| Replace TickerShelf compare | Keep inside collapsible |
| New npm packages | Use existing Collapsible |
| Removing `FUNDAMENTAL_WATCHLIST` | Sector scoring / BUG-01 — later |
| Duplicating ExplainableScore | Soft-use from seq 3 if already shipped |

### Layout (top → bottom)

```
[Today header]
[MacroRegimeStrip]
[FeaturedPickCard × ≤3]
[QuickLinks]
[▼ Full fundamental rankings]  ← Collapsible
  StockCards, PriceChart, RankingsLeaderboard, MetricsTable, …
```

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Title / compare framing | `home.tsx` L148 |
| Regime query on home | L82–91 — already no RegimeBanner required; strip can read same query |
| FUNDAMENTAL_WATCHLIST | L16–20; used peer-groups L71–78 |
| riskFreeRateQuery | L94–104 — keep for rankings path inside collapsible |
| buildReasoning GO/WATCH/NO | `options-scanner.tsx` L123–143 |
| SignalBadge / scanner GO source | Same file — scorecard rows drive signal |
| No FeaturedPick / TodayDashboard | Grep empty |
| Collapsible primitive | `@/components/ui/collapsible` (project shadcn) |
| Lessons | grep layout/Yahoo/home — **none** matching; still honor “no new Yahoo on mount” |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `src/lib/scanner-reasoning.ts` | **New** — move `buildReasoning` (+ types needed) |
| **P0** | `src/pages/options-scanner.tsx` | Import shared; delete local function |
| **P0** | `src/components/home/TodayDashboard.tsx` | **New** — section layout |
| **P0** | `src/components/home/MacroRegimeStrip.tsx` | **New** |
| **P0** | `src/components/home/FeaturedPickCard.tsx` | **New** (shared with seq 6) |
| **P0** | `src/hooks/useFeaturedPicks.ts` (or under `components/home/`) | Client: watchlist − red tag → GO → sort tech score → top 3 |
| **P0** | `src/pages/home.tsx` | Slim orchestrator; keep queries; render TodayDashboard |
| **P1** | `src/components/home/QuickLinks.tsx` | **New** |
| **P2** | Seq 2 `tour-config` / INDEX | After ship: note `TOUR_VERSION` bump; mark this done |

### 4.3 Read-not-modify

| Path | Why |
|---|---|
| `lib/rankings.ts` `computeRankingsV2` | Keep peer-norm behavior |
| `components/rankings-leaderboard.tsx` | Move under collapsible only |
| `components/macro/RegimeBanner.tsx` | Optional reuse patterns; home already has regime string query — don’t double-fetch different endpoints |
| Seq 6 task | Coordinate card API; don’t fork a second card |
| enh/27 precomputed rankings | Out of scope |

### 4.4 Featured picks algorithm (client v1)

1. Watchlist tickers (exclude red tag) — same universe spirit as scanner  
2. From cached technical scorecard rows: `signal === "GO"`  
3. Sort by technical `totalScore` desc  
4. Take 3; `headline = buildReasoning(row, iv, regime)`  
5. **No** options chain fetch on mount — strike/%wk optional null with CTA “Open scanner”

Empty: “No GO signals today” + link `/options-scanner`.

### 4.5 Acceptance

- [ ] `/` shows Today header + macro strip + ≤3 picks above fold without scrolling (desktop)
- [ ] Expand rankings → compare UI works as today (cards, leaderboard, charts)
- [ ] No GO → empty state + scanner CTA
- [ ] Network: no new per-ticker Yahoo/options on cold home if scorecard already cached; no duplicate regime key
- [ ] `buildReasoning` lives in `lib/scanner-reasoning.ts`; scanner still shows reasoning line
- [ ] `FUNDAMENTAL_WATCHLIST` still used for peer-groups / norm — not deleted
- [ ] typecheck + build pass
- [ ] No Redis / no home featured-picks API unless explicitly approved later

### 4.6 Suggested commit message

`feat(ui): redesign home as Today dashboard with featured GO picks`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| Seq 3 ExplainableScore | Soft — wrap pick scores if present |
| Seq 6 top-picks feed | **Share** card/hook — implement once here or extract in same PR |
| Seq 2 onboarding | After ship → bump `TOUR_VERSION` / step 1 anchor |
| Seq 5 scanner simple | Independent; same GO semantics |
| Regime + scorecard APIs | Hard — exist |

---

## 5. Impact & Risk

### Blast radius
Primary landing page layout. Power users who live in compare UI need one click to expand. Rollback = revert `home/*` + restore `home.tsx` title/layout; keep `scanner-reasoning` extract if already used by scanner.

### Bug risks
- Extra options/Yahoo on home → **forbidden** v1  
- Removing `FUNDAMENTAL_WATCHLIST` → score drift (BUG-01)  
- Double regime fetch if strip ignores existing `regimeQuery`  
- Importing `buildReasoning` from page file → circular/heavy — **extract first**  
- Tour step 1 breaks → graceful fallback + version bump

### Performance / cost
Should be equal or better perceived: rankings below fold. Reuse React Query keys from scanner (`technical-scorecard` / equivalents).

### Drift
FeaturedPickCard owned jointly with seq 6 — one component. Title/copy must update tour-config when shipped.

**Do not:** new ranking engine; home AI brief; expand FUNDAMENTAL_WATCHLIST; options N+1 on mount.

---

## Review (2026-07-09) — task-reviewer

**Verdict:** APPROVE-WITH-NITS → nits applied (client picks only; extract reasoning first); **Status ready**

**Lenses:** PM Keep | UX Keep (Today narrative) | Eng Rescope (no home API v1) | BA Keep | User Keep

**Need:** Landing answers CSP “what today?” without denser compare-first chrome.

**Code reality:** Regime + rankings exist; FeaturedPick absent; buildReasoning trapped in scanner.

**Better:** Enhance layout + shared extract; **DEFER** `GET /api/home/featured-picks`; **MERGE** card ownership with seq 6.
