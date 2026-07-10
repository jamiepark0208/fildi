# feature-purpose-research
**Status:** draft (research artifact)  
**Priority:** —  
**Area:** research  
**Created:** 2026-07-09  
**Source:** competitive-research + codebase baseline  

> Master reference for feature improvement PRDs. Competitor gaps are **on top of** what exists — not greenfield. Every linked PRD must follow the baseline checklist and Cache/DB rules below.

---

## Existing baseline checklist (use before editing any PRD)

For each surface, verify and document:

| Field | What to record |
|---|---|
| **UI entry** | Route, tab, component path |
| **API / data** | Routes, cache name + TTL, static vs live |
| **Already comparable** | "We have X; competitor adds Z on top" |
| **Hidden / split** | Same data in two places user doesn't connect |
| **Known limitations** | FMP PT empty, adminOnly, orphan routes |
| **Duplication debt** | e.g. `buildCatalysts` API + frontend |
| **Enhance vs build** | Default **ENHANCE** unless baseline empty |

---

## Cache / DB / performance rules (all feature PRDs)

Aligned with [caching-patterns.md](../../.claude/skills/caching-patterns.md), [data-architecture.md](../../.claude/skills/data-architecture.md), lessons L-01/L-04/L-05.

| Rule | Detail |
|---|---|
| **No new TTLCache** | Unless checklist in caching-patterns completed + registry entry |
| **No Redis / job-queue** | Deferred P3 eng tasks — UX must not invent them |
| **Reuse routes** | Prefer existing `/api/*`; no parallel fetch paths |
| **Breakdown** | `breakdownCache` 2h — bump `BREAKDOWN_CACHE_VER` on payload shape change |
| **Macro** | `macro-data`/`macro-charts` 4h file; `macro-regime` 30m; COT file — derive deltas from cache |
| **Analyst history** | Extend [analyst-data-persistence](6-analyst-data-persistence-070926.md) Track 1 — no live Yahoo U/D fork |
| **Alerts / cron** | v1 = localStorage prefs only; background alerts wait for job-queue approval |
| **N+1** | Never loop watchlist → breakdown; batch or use already-loaded data |
| **Weights** | Only in Scorecard Guide — Settings must link, not duplicate |

**Deferred eng (do not reopen in UX):** `redis-optional-shared-cache`, `job-queue-background-workers`, `precomputed-rankings-materialization`.

---

## Main

### Feed (`/feed`)

| FILDI existing (verified) | Competitor benchmark | Gap |
|---|---|---|
| `feed.tsx` — filters, TradeCard, infinite scroll | Covers featured pick + thesis | ENHANCE thesis line on cards |
| `GET /api/feed/posts` CRUD + like/comment/close | StockTwits trending | ENHANCE trending from post volume (client) |
| `TopPerformers` (min 2 closed) | TipRanks success + sample size | ENHANCE n badges |
| No scanner handoff | — | NEW deep link |

**Task:** [feed-improvements](13-feed-improvements-070926.md)  
**Cache/DB:** reuse feed APIs; no new feed routes v1; trending = client aggregate.

### Watchlist list panel (`/watchlist` left)

| FILDI existing | Competitor | Gap |
|---|---|---|
| Color tags, sort, search-add, quotes (`quote` cache 1h) | Koyfin saved columns | ENHANCE saved views (localStorage) |
| Select → StockBreakdown | SWS score-change alerts | NEW alerts v2 only (no cron) |
| `GET/POST/DELETE /api/watchlist` | Finviz saved screens | ENHANCE named filters |

**Task:** [watchlist-monitor-improvements](16-watchlist-monitor-improvements-070926.md)

### Stock Breakdown (watchlist right + `/breakdown`)

| FILDI existing | Competitor | Gap |
|---|---|---|
| `GET /api/stocks/breakdown`, `breakdownCache` 2h, VER=4 | Simply Wall St rewards/risks narrative | ENHANCE narrative from payload |
| Snowflake + SectionCards | SWS screener→report | ENHANCE (sector scoring separate) |
| Analyst donut + Yahoo U/D live; PT `[]` | TipRanks analyst history | ENHANCE via analyst-data Track 1/2 |
| Catalysts — **duplicate** `buildCatalysts` FE | SA earnings prominence | FIX single source; ENHANCE earnings |
| Competitors peer list | Inline peer ranks elsewhere | ENHANCE chips |
| Orphan `/breakdown` | — | FIX redirect |

**Task:** [stock-breakdown-sections-improvements](12-stock-breakdown-sections-improvements-070926.md)

### Profile (`/profile/:username`)

| FILDI existing | Competitor | Gap |
|---|---|---|
| StatsBar, buckets, SubmitForm (max 3 open), trade list | TipRanks Expert Center | ENHANCE sample size / period |
| Close with premium | Tradervue / Edgewonk tags | NEW post-mortem tags |
| Overlap leaderboard task | Covers credibility | Cross-ref analyst-leaderboard |

**Task:** [profile-track-record-improvements](14-profile-track-record-improvements-070926.md)

### Portfolio (`/portfolio`, **adminOnly** nav)

| FILDI existing | Competitor | Gap |
|---|---|---|
| Manual boxes, Robinhood → `snapshot/latest` | WheelDesk / OptionIncome cycles | NEW cycle P&L (design before DB) |
| `PortfolioAnalysis` risk/delta/income/health | TipRanks Smart Portfolio warnings | ENHANCE concern → breakdown |
| No journal | Edgewonk Tiltmeter | NEW tags on close |
| `DailyBrief` on page | Koyfin morning dash | see daily-brief task |

**Tasks:** [portfolio-analysis-improvements](8-portfolio-analysis-improvements-070926.md), [portfolio-daily-brief-improvements](9-portfolio-daily-brief-improvements-070926.md)

---

## Analysis

### Home `/` — [home-dashboard-redesign](../new_app_features/4-home-dashboard-redesign-070926.md)

| FILDI existing | Competitor | Gap |
|---|---|---|
| Rankings, StockCards, MetricsTable, regimeQuery | Koyfin Today / Covers featured | ENHANCE Today layout (task already scoped) |
| `FUNDAMENTAL_WATCHLIST` hardcode | Sector peers planned | Do not expand hardcode |

### Technical — [technical-scorecard-improvements](15-technical-scorecard-improvements-070926.md)

| FILDI existing | Competitor | Gap |
|---|---|---|
| `computeTechnicalRankingsV2`, cards, table | TradingView alerts | NEW alerts v2; ENHANCE verdict badge |
| Shared with scanner | Barchart signal summary | NEW scanner handoff link |

### Scanner — [scanner-simplified-view](../new_app_features/5-scanner-simplified-view-070926.md)

| FILDI existing | Competitor | Gap |
|---|---|---|
| `buildReasoning`, regime, pickBestStrike, dense grid | Barchart IV Rank workflow | ENHANCE surface reasoning + simple mode |
| Options `optionsCache` 30m | OptionStrat P/L viz | ENHANCE simple cards (no new scorer) |

### Macro tabs

| Tab | FILDI existing | Competitor | Gap | Task |
|---|---|---|---|---|
| Regime | RegimeBanner, highlights AI, charts 4h, indicators+history, eventsToday in packet | Koyfin World Economics | ENHANCE delta strip + CSP implication | [macro-regime-tab-improvements](10-macro-regime-tab-improvements-070926.md) |
| Volatility | VIX + COT in macro; orphan `/sentiment` full COT | Barchart vol | FIX merge sentiment | [macro-volatility-tab-improvements](17-macro-volatility-tab-improvements-070926.md) |
| Policy | Fed, SEP, bank research AI | Fed watch digests | ENHANCE CSP bullets | [macro-policy-tab-improvements](18-macro-policy-tab-improvements-070926.md) |
| Heatmap | TV embed | Finviz click→screen | ENHANCE sector→watchlist hint | [macro-heatmap-tab-improvements](19-macro-heatmap-tab-improvements-070926.md) |
| Catalyst | TV calendar + `/api/macro/events` + highlights events | Koyfin filtered calendar | ENHANCE "Your week" list — **no new calendar API** | [macro-catalyst-calendar-improvements](11-macro-catalyst-calendar-improvements-070926.md) |

---

## General

| Surface | Existing | Gap | Task |
|---|---|---|---|
| Scorecard Guide | Weights + tabs | Presets, deep links | [scorecard-guide-improvements](20-scorecard-guide-improvements-070926.md) |
| Contextual scores | Separate ready task | Inline popovers | [contextual-score-explanations](../new_app_features/3-contextual-score-explanations-070926.md) |
| Settings | Profile + admin ops | Trader prefs tab | [settings-trader-preferences-improvements](21-settings-trader-preferences-improvements-070926.md) |

**Cross-cutting (do not duplicate):** [onboarding-product-tour](../new_app_features/2-onboarding-product-tour-070926.md), [command-palette-navigation](../new_app_features/8-command-palette-navigation-070926.md), [analyst-data-persistence](6-analyst-data-persistence-070926.md), [social-sentiment-polish](../new_app_features/9-social-sentiment-polish-070926.md), [analyst-leaderboard-track-record](../new_app_features/7-analyst-leaderboard-track-record-070926.md).

---

## Exemplars (anti-duplication)

### Economic calendar — already 3 layers
1. TV embed (Catalyst tab)  
2. Indicator table + history (Regime)  
3. `ECONOMIC_EVENTS` / `eventsToday` in highlights + daily brief  

→ Task = filter/link/surface — **not** "add calendar."

### One-page report — already StockBreakdown
→ Task = narrative + FIX catalysts + wire analyst Track 1 — **not** new `/report` page.
