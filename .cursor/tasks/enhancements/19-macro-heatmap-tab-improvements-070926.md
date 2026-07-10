# macro-heatmap-tab-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P2 |
| **Area** | ui |
| **Effort** | S |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [watchlist-monitor](16-watchlist-monitor-improvements-070926.md), [scanner-simplified](../new_app_features/5-scanner-simplified-view-070926.md), [macro-regime](10-macro-regime-tab-improvements-070926.md), [liquidity-money-flow-research](30-liquidity-money-flow-research-070926.md) (**FILDI sector RRG/bubbles live on Liquidity tab — Heatmap stays TradingView; no custom treemap here**) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Sector rotation at a glance — where to point scanner/watchlist today — without replacing the TradingView embed.

### Cache / DB compliance
Keep `TradingViewHeatmap` embed. **No** custom heatmap renderer. **No** new sector API. Watchlist sector hints must use data already available client-side (e.g. quote/`StockMetrics.sector` via existing quote query options, or fundamentals already cached for those tickers). No Redis. No N+1 breakdown.

---

## 1. Executive summary (rescoped)

**Already present:**
- Heatmap tab (`macro.tsx` L639–653+): title + `TradingViewHeatmap` (SPX500 / sector grouping) + `TradingViewMarketOverview`
- Embed: `MacroComponents.tsx` L1527–1554 — TradingView script widget
- **No** FILDI watchlist/scanner linkage under the embed

**Do (Phase A):**
1. Keep TV embed as primary visual
2. **Below embed:** “Your watchlist in sectors” panel — group `useWatchlist()` tickers by `sector` from existing quote metrics (same `getGetStockQuoteQueryOptions` pattern as watchlist page). If sector missing → “Unknown” bucket
3. CTA: **Scan watchlist** → `/options-scanner` (optional note in scanner header later; v1 = navigate only)
4. Optional static helper copy: “Heatmap is market-wide; list below is *your* names” — no Finviz-style click-through into TV (embed can’t reliably emit sector clicks)

**Do not** parse TV iframe clicks, build a FILDI treemap, or add sector performance API.

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Dead embed UX | Heatmap tab = TV only L639–647 |
| Sector on metrics | `StockMetrics.sector` in api-zod types |
| Watchlist has no sector UI | `watchlist.tsx` / `use-watchlist` — tickers + colorTag only |
| Quotes already used on watchlist | `getGetStockQuoteQueryOptions` per row |
| Scanner deep-link pattern | enh/15–16 establishing `/options-scanner` handoffs |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | Heatmap tab: watchlist sector grouping panel under TV |
| W2 | Per sector: ticker chips → `/watchlist?ticker=` (if enh/16 ships) or set nothing / link `/watchlist` |
| W3 | “Open scanner” button |
| W4 | Empty watchlist copy → add names first |

### Out of scope
| Item | Reason |
|---|---|
| Custom heatmap / replace TV | Forbidden v1 |
| New sector performance API | Forbidden |
| Click-capture from TV iframe | Unreliable / out of scope |
| Redis | Forbidden |
| Prefetch breakdown for all WL names | Forbidden |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Tab | `activeTab === "heatmap"` L639 |
| Widget | `TradingViewHeatmap` L1527 — `dataSource: "SPX500"`, `grouping: "sector"` |
| Watchlist hook | `useWatchlist` — reusable on macro page |
| Quote options | watchlist L128–133 pattern |

### 4.2 Files to modify

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/macro.tsx` | Sector panel + CTAs under heatmap |
| **P1** | Optional small helper in `lib/` or inline `useQueries` | Group by sector |
| — | `TradingViewHeatmap` | Prefer no change unless height/CSS |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| enh/16 | `?ticker=` on watchlist |
| options-scanner | CTA target |
| TV embed implementation | Keep as-is |

### 4.4 Paste-ready grouping sketch

```ts
// After useWatchlist + useQueries(getGetStockQuoteQueryOptions)
// Map ticker → data?.sector ?? "Unknown"
// Render: Object.entries(group).sort(...).map(([sector, tickers]) => ...)
```

### 4.5 Acceptance criteria

- [ ] TV embed still primary on Heatmap tab
- [ ] Watchlist tickers listed by sector when sector available on quote
- [ ] Scanner CTA present
- [ ] No new sector API / custom treemap
- [ ] No breakdown N+1
- [ ] stock-compare typecheck

### 4.6 Suggested commit message

`feat(macro): link heatmap tab to watchlist sectors and scanner`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| enh/16 | Soft — watchlist `?ticker=` |
| new_app_features/5 | Soft — scanner header note |
| Quote includes sector | Verify in PR; if null often, show “sector unavailable” not fake leaders |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- macro.tsx heatmap section + quote queries for WL size
- Rollback: remove panel

### 2. Bug introductions
- Extra quote fetches on macro visit — only when heatmap tab active (`enabled: activeTab === "heatmap"`)
- Misleading “leading sectors” without market sector returns — **do not** claim leading/lagging from TV; only “your names by sector”
- Catch: WL with known sectors groups correctly; empty WL shows CTA

### 3. Performance
- Cap: same as watchlist quote fan-out; gate on tab visibility

### 4. Workflow
- See market heatmap → check which of *my* names sit in hot/cold sectors → scan

### 5. Drift
- Paired: heatmap CTAs ↔ watchlist persist ↔ scanner deep-links

**Do not:** replace TV; new sector API; iframe click hacks; fake market leaders.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Was:** draft. **Key:** keep embed; add watchlist-by-sector panel from existing quotes — not a Finviz clone.
