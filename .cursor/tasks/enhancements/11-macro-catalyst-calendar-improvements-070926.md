# macro-catalyst-calendar-improvements

| Field | Value |
|---|---|
| **Status** | ready |
| **Priority** | P1 |
| **Area** | ui |
| **Effort** | M |
| **Created** | 2026-07-09 |
| **Source** | feature-purpose-research |
| **Research** | [feature-purpose-research](1-feature-purpose-research-070926.md) |
| **Related** | [macro-regime](10-macro-regime-tab-improvements-070926.md), [daily-brief](9-portfolio-daily-brief-improvements-070926.md) |
| **Type** | ENHANCE |
| **Impl research** | 2026-07-09 deep (ai/2 intensity) — was thin draft |

### Purpose
Don’t sell puts blind into macro/earnings landmines — calendar filtered to **your** names above the existing TradingView embed.

### Cache / DB compliance
Reuse `GET /api/macro/events`, highlights (`eventsToday` / `eventsThisWeek`), and already-loaded portfolio/watchlist symbols. **Never** N× `GET /stocks/breakdown` on tab open. **No** new `/api/calendar`. **No** Redis.

---

## 1. Executive summary (rescoped)

**Do not** replace the TradingView embed or add a second calendar API.

**Do** add a FILDI **“Your week”** list **above** `TradingViewEconomicCalendar` on the Catalyst tab:
1. Macro events from existing `/api/macro/events` + highlights week window
2. Color-code: portfolio / watchlist / other (client-side)
3. Click macro release row → Regime tab indicator history when applicable (enh/10)
4. Document TV embed limits (no watchlist filter) — custom list is the product value

**Calendar already exists in 3 layers** (integrate, don’t duplicate):
| Layer | Location |
|---|---|
| TV embed | Macro → Catalyst — `TradingViewEconomicCalendar` (`macro.tsx` ~L675) |
| Static events | `GET /api/macro/events` ← `ECONOMIC_EVENTS` (`macro-static` / macro routes L245) |
| Highlights | `eventsToday` / `eventsThisWeek` in `macro-highlights.ts` → MacroHighlightsPanel |

---

## 2. Why (requirements)

| Requirement | Evidence |
|---|---|
| Catalyst tab = embed today | `macro.tsx` activeTab === "catalyst" → TV calendar |
| Events API already fetched on macro page | `macro.tsx` L118 `fetch("/api/macro/events")` |
| Highlights week filter | `macro-highlights.ts` L158–159 |
| TV can’t filter to user book | Embed limitation — document |
| Earnings for “your” names | Must not storm breakdown; use batch/in-memory only |

---

## 3. What (build scope)

### In scope
| # | Work |
|---|---|
| W1 | “Your week” panel above TV embed |
| W2 | Merge/display: events from `/api/macro/events` (and/or highlights week) for next 7d |
| W3 | Color-code rows by membership in portfolio symbols / watchlist / neither |
| W4 | Optional earnings lines **only** if already in memory (brief tickers, snapshot symbols, cached catalysts) — else omit |
| W5 | Click high-importance macro → switch to Regime + scroll/focus indicator if mapped |
| W6 | Short helper text: TV is global; list above is FILDI-filtered |

### Out of scope
| Item | Reason |
|---|---|
| New `/api/calendar` | Forbidden |
| Second TV widget | Forbidden |
| Replace TV embed v1 | Out of scope |
| N× breakdown / quoteSummary for earnings | Forbidden |
| Rebuilding FRED fetch | Out of scope |

---

## 4. Implementation research pack

### 4.1 Baseline verified (2026-07-09)

| Claim | Evidence |
|---|---|
| Catalyst tab | `MacroTab` includes `"catalyst"`; label “Catalyst Calendar” |
| TV component | `MacroComponents.tsx` `TradingViewEconomicCalendar` |
| Events route | `macro.ts` L245 — filter `ECONOMIC_EVENTS` where `date >= today` |
| Page already loads events | `macro.tsx` L118 |
| Highlights week | `eventsThisWeek` in packet |
| Portfolio symbols | Available via snapshot query (same keys as portfolio page) — fetch once with react-query |
| Watchlist | Existing watchlist/session tickers patterns on app |

### 4.2 Files to modify (authoritative)

| Pri | Path | Change |
|---|---|---|
| **P0** | `artifacts/stock-compare/src/pages/macro.tsx` | Above `<TradingViewEconomicCalendar />`, render YourWeek panel |
| **P0** | `artifacts/stock-compare/src/components/macro/YourWeekCalendar.tsx` (or similar) | **New** — presentational + client filter |
| **P1** | Shared symbol sets | Reuse portfolio-snapshot + watchlist query keys — no new API |
| — | `macro-static.ts` / events API | Prefer no change unless date bugs found |
| — | TV embed internals | No replace |

### 4.3 Files to read but **not** modify

| Path | Why |
|---|---|
| `TradingViewEconomicCalendar` | Keep as-is |
| `macro-highlights.ts` | Packet shape; don’t fork AI |
| `ECONOMIC_EVENTS` | Source list |
| enh/9 / enh/10 | Cross-links and shared filters |

### 4.4 Your-week algorithm (spec)

```
symbolsPortfolio = from snapshot positions/options (uppercase)
symbolsWatchlist = from existing watchlist state/query
events = props.events from /api/macro/events (already on page) 
  OR highlights.eventsToday + eventsThisWeek
rows = events in [today, today+7d]
for each row:
  bucket = portfolio if event text/ticker hits portfolio
         else watchlist if hits watchlist
         else other
sort: high importance first, then date
onClick macro release with known indicator key → setTab("regime") + optional hash
earnings:
  ONLY append if earningsDate already known for symbol in memory map
  else skip — never fetch breakdown to populate this list
```

### 4.5 Acceptance criteria

- [ ] Catalyst tab shows Your week list above TV embed
- [ ] Opening tab does **not** fire N breakdown requests (network tab)
- [ ] Portfolio / watchlist / other styling distinguishable
- [ ] Uses `/api/macro/events` and/or highlights — no new calendar route
- [ ] Helper copy documents TV global vs FILDI list
- [ ] stock-compare typecheck

### 4.6 Suggested commit message

`feat(macro): your-week event list above catalyst calendar`

### 4.7 Dependencies

| Dep | Relation |
|---|---|
| **enh/10** | Jump to Regime / deltas |
| **enh/9** | Shared “your tickers” filtering patterns |
| enh/8 | Portfolio unlock for symbol set |

---

## 5. Data note
`ECONOMIC_EVENTS` is static/curated — stale dates are a data-maintenance issue, not solved by a new API in this task.

## 6. Impact & Risk Analysis

### 1. Blast radius
- macro Catalyst tab UI only
- Rollback: remove YourWeek component

### 2. Bug introductions
- N+1 earnings fetch temptation — hard ban in acceptance
- Empty list when ECONOMIC_EVENTS outdated — show empty state + still keep TV
- Catch: open Catalyst with portfolio loaded; confirm color buckets; network clean

### 3. Performance
- Client filter on existing arrays; one optional snapshot query (cached)

### 4. Workflow
- Before: global TV only  
- After: your week + global embed  

### 5. Drift
- Paired: events API ↔ highlights week ↔ brief “your tickers” (enh/9)

### 6. Scalability
- Static event list size small; don’t scrape TV DOM

**Do not:** new calendar API; second TV widget; breakdown storm.

---

## Review (2026-07-09) — ai/2 intensity

**Verdict:** APPROVE — ready  
**Was:** draft. **Key:** three calendar layers already exist — add filtered list above TV, nothing more.
