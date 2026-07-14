# portfolio-daily-brief-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M (~1 session Phase A) |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [portfolio-analysis](8-portfolio-analysis-improvements-070926.md), [macro-regime](10-macro-regime-tab-improvements-070926.md), [home](../new_app_features/4-home-dashboard-redesign-070926.md) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Morning context on **your** holdings and macro — not generic market news. Pin and personalize the existing brief; do not build a second AI pipeline.

### Cache / DB compliance
Reuse `GET /api/daily-brief`, `/market`, `/history`, `GET|PATCH /api/daily-brief/context`, plus macro highlights / events. **No** N+1 `breakdown` fetches. **No** Redis. **No** new LLM route.

---

## 1. Executive summary (rescoped)

**Do not** add email delivery, a second Haiku brief, or duplicate `macro-highlights.ts`.

**Do** (Phase A):
1. Pin / reorder `DailyBrief` to the top of the portfolio main column when a Robinhood snapshot (or manual positions) exists
2. Add **“Your tickers today”** subsection fed by existing highlights `eventsToday` / catalysts already on the page — batch only
3. On Macro Regime tab: link “Portfolio brief” → `/portfolio` when user has a snapshot (coordinate with enh/10)

**Correct API note:** context is `GET` + **`PATCH`** `/api/daily-brief/context` (admin) — not POST.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Brief already on portfolio | `portfolio.tsx` L905 — `<DailyBrief tickers={uniqueTickers} />` **below** RH summary, **above** `PortfolioAnalysis` |
| Market chips + today/history | `daily-brief.tsx` — `/market`, `/daily-brief`, `/history` |
| Admin generate/refresh | `isAdmin` gates Generate / Refresh |
| Overlap with macro highlights | Same `eventsToday` packet used by `MacroHighlightsPanel` |
| Not holdings-first layout | Brief not pinned when positions exist; no “your tickers” strip |

---

## 3. What (build scope)

### In scope — Phase A
| # | Work |
|---|---|
| A1 | Reorder portfolio layout: when `rhData?.snapshot` or manual positions → render `DailyBrief` first (or sticky top) |
| A2 | “Your tickers today”: intersect portfolio/watchlist tickers with events/catalysts **already available** (highlights fetch once, or props from parent) — **no** per-ticker breakdown |
| A3 | Default expanded when positions exist (optional UX) |
| A4 | Macro Regime → “Open portfolio brief” link if snapshot exists (enh/10 may own placement) |

### Out of scope
| Item | Reason |
|---|---|
| Second LLM / new brief endpoint | Forbidden |
| Email newsletter | Defer |
| Full AI one-liner on home | new_app_features/4 — link only |
| Redis | Forbidden |
| Duplicating macro-highlights generation | Reuse `/api/macro/highlights` or existing panel data |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| DailyBrief on portfolio | `portfolio.tsx` L905 |
| Snapshot query | L737–745 `portfolio-snapshot-latest` |
| Brief APIs | `daily-brief.ts`: `/market` L222, `/history` L232, `/daily-brief` L240, `/context` GET L278, **PATCH** L284 |
| Tickers prop | `DailyBrief({ tickers })` — already passed `uniqueTickers` |
| Highlights events | `macro-highlights.ts` L158–159 filter `ECONOMIC_EVENTS`; panel shows `EventsStrip` |
| No “Your tickers” UI | Not in daily-brief.tsx today |

### 4.2 Files to modify (authoritative)

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/portfolio.tsx` | Reorder: Brief above analysis/summary when positions exist |
| **P0** | `artifacts/stock-compare/src/components/daily-brief.tsx` | Optional “Your tickers today” block; consume highlights or parent props |
| **P1** | Macro regime section in `macro.tsx` / `RegimeBanner` area | Link to `/portfolio` (with enh/10) |
| — | `routes/daily-brief.ts` | Prefer **no** change |
| — | `macro-highlights.ts` | Prefer **no** fork — fetch existing highlights endpoint if needed |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `MacroHighlightsPanel.tsx` | Events strip pattern to reuse, not copy-paste logic |
| `macro-highlights.ts` | Packet shape |
| enh/8 | Unlock portfolio nav so non-admins can reach brief |
| new_app_features/4 | Home one-liner later |

### 4.4 “Your tickers today” algorithm (spec)

```
inputs: portfolioSymbols[], watchlistSymbols[], eventsToday[], eventsThisWeek[], optional catalystsByTicker
match:
  - macro events: show all high-importance today (global) + any event text mentioning a held ticker if present
  - earnings/catalyst lines: only for symbols in portfolio ∪ watchlist already in memory
forbid:
  - for (ticker of portfolio) fetch(/api/stocks/breakdown?ticker=...)
```

### 4.5 Acceptance criteria

- [ ] With snapshot/positions: Brief is visually first / pinned in portfolio column
- [ ] Without positions: layout still usable (brief may stay lower or collapsed)
- [ ] “Your tickers today” uses existing APIs only — network tab shows **no** N× breakdown
- [ ] No new LLM endpoint; generate still admin-gated as today
- [ ] Context still PATCH (docs/comments corrected if any say POST)
- [ ] stock-compare typecheck

### 4.6 Suggested commit message

`feat(portfolio): pin daily brief and surface your-tickers events`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **enh/8** | Non-admins need Portfolio nav |
| **enh/10** | Cross-link from Regime |
| **enh/11** | Shared “your week” event UX patterns |

---

## 5. Data note
Brief history is file-backed (`daily-brief.ts` HISTORY_PATH) — unchanged.

## 6. Impact & Risk Analysis

- Share the react-query key for highlights if both portfolio and macro mount it, to avoid a double-fetch
- Hide the "your tickers" section entirely when there are no matches, rather than showing empty noise
- Paired with highlights packet ↔ brief "your tickers" ↔ catalyst tab list (enh/11) — keep those in sync

**Do not:** second AI; email; Redis; N+1 breakdown.

---

## Review: APPROVE — ready (Phase A). Context is PATCH; brief already on page — pin/personalize, don't rebuild.
