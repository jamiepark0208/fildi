# watchlist-monitor-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M (Phase A); alerts = v2 stub |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [stock-breakdown-sections](12-stock-breakdown-sections-improvements-070926.md), [onboarding](../new_app_features/2-onboarding-product-tour-070926.md), [scanner-simplified](../new_app_features/5-scanner-simplified-view-070926.md) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Monitor your CSP universe — keep selection context across reloads and make color tags / empty states actionable without a second watchlist product.

### Cache / DB compliance
Reuse `GET/POST/DELETE /api/watchlist` + `useWatchlist`. Quotes stay on existing quote query options. Prefs / named views / last ticker = **localStorage only**. No N+1 breakdown on list load (breakdown only for selected). No Redis. No alert workers.

---

## 1. Executive summary (rescoped)

**Already present (do not rebuild):**
- Left list + right `<StockBreakdown ticker={selectedTicker} />` (`watchlist.tsx` L368)
- Color tags via `PRESET_COLORS` + localStorage map in `use-watchlist.ts` (per-user key)
- Color **filter** already exists (`filterColor` + `filteredEntries` L123–126)
- Sort by symbol / last / chg
- Empty list copy: “No tickers in watchlist.” (L271) — weak CTA
- Right empty: “Select a security…” (L360–366) — no scanner handoff

**Do (Phase A):**
1. Persist **last selected ticker** in localStorage (scoped by userId like colors)
2. On load: restore selection if still in watchlist; else clear
3. Empty-list CTA: “Add from scanner GO list” → `/options-scanner` (and/or technical)
4. Color **legend** (what green/red mean for CSP workflow) — copy only near filter chips
5. Named views: save `{ name, filterColor }` sets in localStorage — **client only** (color filter already works; named views = presets over that)

**v2:** Alert prefs stub only — blocked without job-queue approval (enh eng tasks).

Coordinate breakdown CTAs with [enh/12](12-stock-breakdown-sections-improvements-070926.md) (scanner/compare on breakdown header).

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Selection not persisted | `useState<string \| null>(null)` L33 — lost on reload |
| Colors already localStorage | `colorKey` / `loadColorMap` in `use-watchlist.ts` L24–36 |
| Filter by color exists | `filterColor` → `filteredEntries` L123–126 |
| Empty CTA weak | L271, L360–366 — no scanner link |
| Quotes path OK | `getGetStockQuoteQueryOptions` per visible row L128–133 |
| CRUD solid | `addEntry` / `removeEntry` / `updateColorTag` |

---

## 3. What (build scope)

### Phase A — in scope
| # | Work |
|---|---|
| A1 | `fildi_watchlist_selected_{userId}` localStorage; restore on mount if ticker ∈ entries |
| A2 | Empty list: link to `/options-scanner` (+ optional `/technical`) |
| A3 | Legend under color filter: short CSP meanings (e.g. green = candidates, red = avoid) — product copy in PR |
| A4 | Named views: localStorage array of `{ id, name, filterColor }`; UI to save current filter + apply |
| A5 | Optional: deep-link `/watchlist?ticker=X` select that ticker (helps enh/12 orphan `/breakdown` redirect) |

### Phase B / v2 — deferred
| # | Work |
|---|---|
| B1 | Alert prefs UI stub (price / score / earnings) — no pollers |
| B2 | Background workers — only after job-queue eng approval |

### Out of scope
| Item | Reason |
|---|---|
| Second watchlist API | Forbidden |
| Server-side named views | localStorage only v1 |
| N+1 breakdown prefetch for all rows | Forbidden |
| Redis / push alerts | Forbidden |
| Rebuild CRUD | Forbidden |
| Orphan `/breakdown` decision | Owned by enh/12 |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Page | `artifacts/stock-compare/src/pages/watchlist.tsx` |
| Hook | `artifacts/stock-compare/src/hooks/use-watchlist.ts` |
| Selection | L33 `selectedTicker`; click L290; clear on remove L323 |
| Breakdown embed | L368 |
| Color filter UI | usedColors L165–169; filter chips in left panel |
| App route | `/watchlist` — no query handling today |

### 4.2 Files to modify (Phase A)

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/watchlist.tsx` | Persist selection; empty CTAs; legend; named views UI |
| **P1** | `artifacts/stock-compare/src/hooks/use-watchlist.ts` | Optional helpers for selected-key / views keys (keep colors API stable) |
| — | `/api/watchlist` routes | Prefer no change |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `stock-breakdown.tsx` | Right panel — CTAs in enh/12 |
| `options-scanner.tsx` | Empty CTA target |
| new_app_features/2 | Onboarding copy alignment |

### 4.4 Paste-ready persistence sketch

```ts
function selectedKey(userId?: number) {
  return userId ? `fildi_watchlist_selected_${userId}` : "fildi_watchlist_selected";
}
// On select: localStorage.setItem(selectedKey(userId), ticker)
// On mount after entries load:
//   const saved = localStorage.getItem(...);
//   if (saved && entries.some(e => e.ticker === saved)) setSelectedTicker(saved);
```

### 4.5 Named views shape (localStorage)

```ts
type WatchlistView = { id: string; name: string; filterColor: string | null };
// key: fildi_watchlist_views_${userId}
```

### 4.6 Acceptance criteria

- [ ] Reload restores last selected ticker if still on list
- [ ] Removed ticker clears selection + storage
- [ ] Empty list offers scanner CTA
- [ ] Color legend visible when presets used
- [ ] Named views save/apply without new API
- [ ] No breakdown fetch until selection
- [ ] No alert workers in Phase A
- [ ] stock-compare typecheck

### 4.7 Suggested commit message

`feat(watchlist): persist selection, legend, and local named views`

### 4.8 Dependencies

| Dep | Relation |
|---|---|
| **enh/12** | Breakdown header CTAs; optional `?ticker=` on watchlist |
| new_app_features/2 | Empty-state / tour copy |
| Job-queue eng | Hard for real alerts (v2) |

---

## 5. Impact & Risk Analysis

### 1. Blast radius
- watchlist.tsx (+ small hook helpers)
- Rollback: revert; clear localStorage keys if needed

### 2. Bug introductions
- Restore ticker not in list after remove elsewhere → must validate against entries
- Multi-user same browser — must scope keys by userId (match color map)
- Named views with stale color hex — treat missing filter as “all”
- Catch: select AAPL, reload, breakdown still AAPL

### 3. Performance
- No extra quote/breakdown calls beyond today

### 4. Workflow
- Watchlist as command center: list → breakdown → scanner (via enh/12)

### 5. Drift
- Paired: selection persist ↔ enh/12 deep-link ↔ color map keys

**Do not:** new watchlist API; Redis alerts; N+1 breakdown; server named views.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Was:** draft. **Key:** color filter already exists; gap is selection persistence + empty CTA + legend/named views in localStorage.
